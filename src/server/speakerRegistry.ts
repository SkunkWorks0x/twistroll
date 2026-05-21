// Session-scoped registry that resolves Deepgram numeric speaker IDs to real
// names by ATTRIBUTION, not bare utterance. Rules, in priority order:
//
//   1. Self-intro ("I'm X", "my name is X") → bind THIS speaker, pin.
//   2. Host indicator ("welcome to twist") with no name → bind THIS speaker
//      as the primary host (first host in roster). Fires once per session.
//   3. Addressing ("welcome X", "thanks X", "X, what do you...") → bind the
//      OTHER most-recently-active speaker to the addressed name.
//   4. Elimination (after 60s or >10 segments): if 2-3 speakers observed,
//      at least one host bound, and one unbound speaker remains, bind the
//      remaining speaker to the first expected guest from the title.
//   5. Bare mention ("Alex said X") → no-op. This is the key fix.
//
// Manual override (manualOverride) pins permanently and wins over all rules.
// Sources for "expected guest" names: YouTube episode title (initializeRegistry).
// Sources for host names: config/hosts.json roster.

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
const lastUtterance = new Map<number, number>();
let totalSegmentCount = 0;
let registryStartAt = 0;

export function initializeRegistry(metadata?: { title?: string }): void {
  bindings.clear();
  lastUtterance.clear();
  totalSegmentCount = 0;
  registryStartAt = Date.now();
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
  const patterns = [
    /E\d+:\s*(.+?)['‘’]s\s+/i,
    /E\d+:\s*(.+?)\s+on\s+/i,
    /with\s+(.+?)(?:\s+on|\s*\||\s*-)/i,
  ];
  for (const re of patterns) {
    const m = title.match(re);
    if (m && m[1]) {
      const candidate = m[1].trim();
      if (candidate.length >= 3 && /\s/.test(candidate)) {
        guesses.push(candidate);
      }
    }
  }
  return Array.from(new Set(guesses.map((g) => g.toLowerCase())));
}

export function observeSegment(speakerId: number, text: string): void {
  lastUtterance.set(speakerId, Date.now());
  totalSegmentCount++;

  const existing = bindings.get(speakerId);
  if (existing?.pinned) {
    tryElimination();
    return;
  }

  // Rule 1 — self-intro pins this speaker. Can rebind a prior non-pinned auto-binding.
  const self = matchSelfIntro(text);
  if (self) {
    bindings.set(speakerId, { name: self.name, role: self.role, pinned: true });
    console.log(`[speakerRegistry] Rule 1: bound speaker=${speakerId} → "${self.name}" (self-intro, role=${self.role})`);
    tryElimination();
    return;
  }

  // Subsequent rules only fire on unbound speakers.
  if (existing) {
    tryElimination();
    return;
  }

  // Rule 2 — host indicator (no name in utterance) binds this speaker as primary host.
  if (!anyHostBound()) {
    const hostHit = matchHostIndicator(text);
    if (hostHit) {
      const primary = getPrimaryHost();
      if (primary) {
        bindings.set(speakerId, { name: primary, role: 'host', pinned: false });
        console.log(`[speakerRegistry] Rule 2: bound speaker=${speakerId} → "${primary}" (host indicator: "${hostHit}")`);
        tryElimination();
        return;
      }
    }
  }

  // Rule 3 — addressing pattern binds the OTHER most-recently-active speaker.
  const address = matchAddressing(text);
  if (address) {
    const otherId = findOtherSpeaker(speakerId);
    if (otherId !== null && !bindings.has(otherId)) {
      bindings.set(otherId, { name: address.name, role: address.role, pinned: false });
      console.log(`[speakerRegistry] Rule 3: bound speaker=${otherId} → "${address.name}" (addressed by speaker ${speakerId})`);
    }
  }

  // Rule 5 — bare mention falls through with no binding. By design.

  tryElimination();
}

// ─── Rule matchers ──────────────────────────────────────────────────────

function matchSelfIntro(text: string): { name: string; role: SpeakerRole } | null {
  // Trigger words use [aA] alternations to allow sentence-start or mid-sentence
  // case. The /i flag is intentionally NOT used — it would defeat the [A-Z]
  // uppercase requirement on the captured name (e.g., "this is gonna be" would
  // capture "gonna be" as a name). Captures are bound ONLY if they match the
  // host roster or an expected guest — no free-form fallback.
  const patterns = [
    /\bI['‘’]m\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
    /\b[Mm]y\s+name\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
    /\b[Tt]his\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+here\b/,
    /\b[Ii]t['‘’]s\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const name = m[1].trim();
    const host = matchHostRoster(name);
    if (host) return { name: host, role: 'host' };
    const guest = matchExpectedGuest(name);
    if (guest) return { name: guest, role: 'guest' };
  }
  return null;
}

function matchHostIndicator(text: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/welcome to twist/i, 'welcome to twist'],
    [/welcome back to/i, 'welcome back to'],
    [/welcome everybody/i, 'welcome everybody'],
    [/today on twist/i, 'today on twist'],
    [/three days a week/i, 'three days a week'],
    [/our guest today/i, 'our guest today'],
  ];
  for (const [re, label] of patterns) {
    if (re.test(text)) return label;
  }
  return null;
}

function matchAddressing(text: string): { name: string; role: SpeakerRole } | null {
  // /i flag intentionally absent — [A-Z] must enforce uppercase on the captured
  // name. Trigger words use [aA] alternations for sentence-start vs mid-sentence.
  const patterns = [
    /\b[Ww]elcome\s+([A-Z][a-z]+)\b/,
    /\b[Tt]hanks\s+([A-Z][a-z]+)\b/,
    /\b([A-Z][a-z]+),\s*what\s+do\s+you\b/,
    /\b([A-Z][a-z]+),\s*tell\s+us\b/,
    /\b[Rr]ight\s+([A-Z][a-z]+)\?/,
    /\b[Gg]o\s+ahead\s+([A-Z][a-z]+)\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const name = m[1].trim();
    const host = matchHostRoster(name);
    if (host) return { name: host, role: 'host' };
    const guest = matchExpectedGuest(name);
    if (guest) return { name: guest, role: 'guest' };
  }
  return null;
}

function tryElimination(): void {
  const elapsedMs = Date.now() - registryStartAt;
  const ready = elapsedMs > 60_000 || totalSegmentCount > 10;
  if (!ready) return;
  if (expectedGuests.length === 0) return;
  const observed = Array.from(lastUtterance.keys());
  if (observed.length < 2 || observed.length > 3) return;
  const unbound = observed.filter((id) => !bindings.has(id));
  if (unbound.length !== 1) return;
  if (!anyHostBound()) return;
  const guestName = titleCase(expectedGuests[0]);
  bindings.set(unbound[0], { name: guestName, role: 'guest', pinned: false });
  console.log(`[speakerRegistry] Rule 4: bound speaker=${unbound[0]} → "${guestName}" (elimination)`);
}

// ─── Roster lookups ─────────────────────────────────────────────────────

function matchHostRoster(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [fullName, aliases] of Object.entries(hostRoster.hosts)) {
    if (fullName.toLowerCase() === lower) return titleCase(fullName);
    if (aliases.some((a) => a.toLowerCase() === lower)) return titleCase(fullName);
    const lastWord = fullName.split(/\s+/).pop();
    if (lastWord && lastWord.toLowerCase() === lower) return titleCase(fullName);
  }
  return null;
}

function matchExpectedGuest(name: string): string | null {
  const lower = name.toLowerCase();
  for (const guest of expectedGuests) {
    if (guest === lower) return titleCase(guest);
    const firstWord = guest.split(/\s+/)[0];
    if (firstWord && firstWord.toLowerCase() === lower) return titleCase(guest);
  }
  return null;
}

function getPrimaryHost(): string | null {
  // Convention: first entry in config/hosts.json is the primary host (Jason for TWiST).
  const first = Object.keys(hostRoster.hosts)[0];
  return first ? titleCase(first) : null;
}

function anyHostBound(): boolean {
  for (const b of bindings.values()) if (b.role === 'host') return true;
  return false;
}

function findOtherSpeaker(currentId: number): number | null {
  let bestId: number | null = null;
  let bestTs = -1;
  for (const [id, ts] of lastUtterance) {
    if (id === currentId) continue;
    if (ts > bestTs) {
      bestTs = ts;
      bestId = id;
    }
  }
  return bestId;
}

// ─── Public API (unchanged signatures) ───────────────────────────────────

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

// ─── Utilities ──────────────────────────────────────────────────────────

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}
