// Session-scoped registry that resolves Deepgram numeric speaker IDs to real
// names. Three sources, checked in order on each unbound observation:
//   1. Hardcoded host roster (config/hosts.json) — TWiST recurring hosts
//   2. Expected guests parsed from the YouTube episode title (if provided)
//   3. Introduction-pattern scan ("I'm X", "my name is X", "welcome X")
//
// Manual overrides pin a speakerId — observeSegment becomes a no-op for any
// pinned speaker. In-memory only; cleared on initializeRegistry().

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOSTS_PATH = resolve(__dirname, '..', '..', 'config', 'hosts.json');

interface HostsConfig {
  hosts: Record<string, string[]>;
}

export type SpeakerRole = 'host' | 'guest';

interface Binding {
  name: string;
  role: SpeakerRole;
  pinned: boolean;
}

let hostRoster: HostsConfig = { hosts: {} };
let expectedGuests: string[] = [];
const bindings = new Map<number, Binding>();

export function initializeRegistry(metadata?: { title?: string }): void {
  bindings.clear();
  expectedGuests = [];
  try {
    if (existsSync(HOSTS_PATH)) {
      hostRoster = JSON.parse(readFileSync(HOSTS_PATH, 'utf-8'));
    } else {
      hostRoster = { hosts: {} };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[speakerRegistry] failed to load hosts.json: ${msg}`);
    hostRoster = { hosts: {} };
  }
  if (metadata?.title) {
    expectedGuests = extractGuestsFromTitle(metadata.title);
    if (expectedGuests.length > 0) {
      console.log(`[speakerRegistry] expected guests from title: ${expectedGuests.join(', ')}`);
    }
  }
}

function extractGuestsFromTitle(title: string): string[] {
  const guesses: string[] = [];
  // Smart quotes (U+2018 / U+2019) and ASCII apostrophe both accepted.
  const patterns = [
    /E\d+:\s*(.+?)['‘’]s\s+/i,
    /E\d+:\s*(.+?)\s+on\s+/i,
    /with\s+(.+?)(?:\s+on|\s*\||\s*-)/i,
  ];
  for (const re of patterns) {
    const m = title.match(re);
    if (m && m[1]) {
      const candidate = m[1].trim();
      // Require at least one space — single-word matches are too noisy
      // (brand names, common nouns) to treat as guest identity.
      if (candidate.length >= 3 && /\s/.test(candidate)) {
        guesses.push(candidate);
      }
    }
  }
  return Array.from(new Set(guesses.map((g) => g.toLowerCase())));
}

export function observeSegment(speakerId: number, text: string): void {
  const existing = bindings.get(speakerId);
  if (existing?.pinned) return;
  if (existing) return;

  // 1. Host roster — alias word-boundary match
  for (const [fullName, aliases] of Object.entries(hostRoster.hosts)) {
    for (const alias of aliases) {
      const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
      if (re.test(text)) {
        bindings.set(speakerId, { name: titleCase(fullName), role: 'host', pinned: false });
        console.log(`[speakerRegistry] bound speaker=${speakerId} → "${titleCase(fullName)}" (host roster: ${alias})`);
        return;
      }
    }
  }

  // 2. Expected guest from title — match first-name word-boundary
  for (const guest of expectedGuests) {
    const firstName = guest.split(/\s+/)[0];
    if (!firstName) continue;
    const re = new RegExp(`\\b${escapeRegex(firstName)}\\b`, 'i');
    if (re.test(text)) {
      bindings.set(speakerId, { name: titleCase(guest), role: 'guest', pinned: false });
      console.log(`[speakerRegistry] bound speaker=${speakerId} → "${titleCase(guest)}" (title guest)`);
      return;
    }
  }

  // 3. Introduction patterns
  const introPatterns = [
    /\bI['‘’]m\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
    /\bmy\s+name\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i,
    /\bwelcome\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
  ];
  for (const re of introPatterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const name = m[1].trim();
      const role: SpeakerRole = isAliasOfHost(name) ? 'host' : 'guest';
      bindings.set(speakerId, { name, role, pinned: false });
      console.log(`[speakerRegistry] bound speaker=${speakerId} → "${name}" (intro pattern, role=${role})`);
      return;
    }
  }
}

function isAliasOfHost(name: string): boolean {
  const lower = name.toLowerCase();
  for (const aliases of Object.values(hostRoster.hosts)) {
    if (aliases.some((a) => a.toLowerCase() === lower)) return true;
  }
  return false;
}

export function lookup(speakerId: number): { name: string | null; role: SpeakerRole | null } {
  const b = bindings.get(speakerId);
  return b ? { name: b.name, role: b.role } : { name: null, role: null };
}

export function manualOverride(speakerId: number, name: string, role: string): void {
  if (!name) return;
  const normalizedRole: SpeakerRole = role === 'host' ? 'host' : 'guest';
  bindings.set(speakerId, { name, role: normalizedRole, pinned: true });
  console.log(`[speakerRegistry] manual override speaker=${speakerId} → "${name}" (pinned, role=${normalizedRole})`);
}

export function getRegistry(): Map<number, { name: string; role: SpeakerRole }> {
  const out = new Map<number, { name: string; role: SpeakerRole }>();
  for (const [id, b] of bindings) out.set(id, { name: b.name, role: b.role });
  return out;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
