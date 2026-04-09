/**
 * Daily Brief — per-episode producer brief loaded by index.ts.
 *
 * Stores a list of paid ads with trigger phrases the producer wants Not Ad
 * to surface contextually during a live show. checkBrief() runs on every
 * non-viewer utterance in parallel with the existing sponsor guardian and
 * returns the first matching ad (with also_matched recorded internally).
 * generateNotAdOutput() turns the match into a personality bubble + producer
 * pivot via Claude Haiku.
 */

import type { ParsedUtterance } from '../shared/types.js';

export interface BriefAd {
  sponsor: string;
  url: string;
  code: string | null;
  copy: string;
  triggers: string[];
  angle: string;
}

export interface DailyBrief {
  episode: number;
  date: string;
  ads: BriefAd[];
}

export interface NotAdOutput {
  personality_bubble: string;
  matched_ad: BriefAd;
  matched_trigger: string;
  neutral_pivot: string;
  also_matched: BriefAd[];
}

// ─── State ─────────────────────────────────────────────────────────
let currentBrief: DailyBrief | null = null;
const lastFiredPerSponsor = new Map<string, number>(); // sponsor → last fire ms
const FIRE_DEDUPE_MS = 10 * 60 * 1000; // 10 minutes per spec
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const HAIKU_TIMEOUT_MS = 6000;

export function loadBrief(brief: DailyBrief): void {
  currentBrief = brief;
  lastFiredPerSponsor.clear();
  console.log(`[brief] Loaded episode ${brief.episode} with ${brief.ads.length} ads`);
}

export function clearBrief(): void {
  currentBrief = null;
  lastFiredPerSponsor.clear();
  console.log('[brief] Cleared');
}

export function getCurrentBrief(): DailyBrief | null {
  return currentBrief;
}

// ─── Detection ─────────────────────────────────────────────────────
/**
 * Internal storage for the most recent checkBrief() also-matched list,
 * read by the worker after a positive match. Reset on every check.
 */
let lastAlsoMatched: BriefAd[] = [];
let lastMatchedTrigger = '';

export function getLastAlsoMatched(): BriefAd[] {
  return lastAlsoMatched.slice();
}
export function getLastMatchedTrigger(): string {
  return lastMatchedTrigger;
}

/**
 * First-match-wins: scan ads in order; for each, check if any trigger
 * substring (case-insensitive) appears in the utterance. The first ad that
 * hits AND is past its 10-minute dedupe window is returned. Any ads that
 * also matched are recorded in lastAlsoMatched.
 */
export function checkBrief(text: string): BriefAd | null {
  lastAlsoMatched = [];
  lastMatchedTrigger = '';
  if (!currentBrief || currentBrief.ads.length === 0) return null;

  const lower = text.toLowerCase();
  let chosen: BriefAd | null = null;
  let chosenTrigger = '';

  for (const ad of currentBrief.ads) {
    const hit = ad.triggers.find((t) => lower.includes(t.toLowerCase()));
    if (!hit) continue;

    if (!chosen) {
      // First-match-wins: dedupe check on the chosen ad
      const last = lastFiredPerSponsor.get(ad.sponsor) ?? 0;
      if (Date.now() - last < FIRE_DEDUPE_MS) {
        // Sponsor on cooldown — don't fire, but keep scanning so also_matched
        // captures any other ad that hit on this same utterance. Treat the
        // dedupe-blocked ad as if it didn't match for chosen-purposes.
        continue;
      }
      chosen = ad;
      chosenTrigger = hit;
    } else {
      lastAlsoMatched.push(ad);
    }
  }

  if (chosen) {
    lastMatchedTrigger = chosenTrigger;
    lastFiredPerSponsor.set(chosen.sponsor, Date.now());
  }
  return chosen;
}

// ─── Haiku call for personality bubble + neutral pivot ────────────
function buildPrompt(ad: BriefAd, recent: ParsedUtterance[], trigger: string): string {
  const transcript = recent
    .map((u) => `${u.speaker === 'you' ? 'Host' : 'Guest'}: "${u.text}"`)
    .join('\n');
  return `You are "Not Ad", a deadpan voice in a live podcast sidebar that surfaces sponsor moments without sounding like an ad. The producer pre-loaded this brief on today's episode.

Recent conversation:
${transcript}

The host or guest just said something containing the trigger: "${trigger}"

Sponsor: ${ad.sponsor}
Sponsor copy: ${ad.copy}
Promo code: ${ad.code ?? 'none'}
Producer's angle for today: ${ad.angle}

Generate a JSON object with exactly two fields:
- "personality_bubble": a short, dry, sidebar-style line (max 22 words, one sentence). Sounds like a knowing aside, not a pitch. No exclamation marks. No "buy now" energy. References the ${ad.sponsor} brand naturally OR acknowledges the trigger moment with a wink.
- "neutral_pivot": a single sentence (max 18 words) the producer can read live to pivot from the trigger moment into the sponsor read. Sounds like a natural host transition, not a script.

Respond with strictly valid JSON, no prose before or after:
{
  "personality_bubble": "...",
  "neutral_pivot": "..."
}`;
}

function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object');
  return JSON.parse(raw.slice(start, end + 1));
}

export async function generateNotAdOutput(
  ad: BriefAd,
  recent: ParsedUtterance[],
  alsoMatched?: BriefAd[]
): Promise<NotAdOutput | null> {
  const trigger = lastMatchedTrigger || ad.triggers[0] || '';
  const fallback: NotAdOutput = {
    personality_bubble: `${ad.sponsor} just walked in the door — funny how that works.`,
    matched_ad: ad,
    matched_trigger: trigger,
    neutral_pivot: `Speaking of which — ${ad.copy}`,
    also_matched: alsoMatched ?? lastAlsoMatched.slice(),
  };

  const apiKey = process.env.CLOUD_API_KEY;
  if (!apiKey) {
    console.warn('[not-ad] CLOUD_API_KEY not set — using fallback bubble');
    return fallback;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 300,
        system:
          'You output strictly valid JSON, nothing else. Never include prose before or after.',
        messages: [{ role: 'user', content: buildPrompt(ad, recent, trigger) }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Haiku http ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const raw = data.content?.[0]?.text ?? '';
    const parsed = extractJson(raw) as { personality_bubble?: string; neutral_pivot?: string };

    return {
      personality_bubble: parsed.personality_bubble || fallback.personality_bubble,
      matched_ad: ad,
      matched_trigger: trigger,
      neutral_pivot: parsed.neutral_pivot || fallback.neutral_pivot,
      also_matched: alsoMatched ?? lastAlsoMatched.slice(),
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[not-ad] Haiku failed (${msg}) — using fallback`);
    return fallback;
  }
}
