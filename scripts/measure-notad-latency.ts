/**
 * Measure Not Ad (Haiku) latency — 20 sequential calls, print p50/p75/p90/max.
 * Usage: npx tsx scripts/measure-notad-latency.ts
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  loadBrief,
  checkBrief,
  generateNotAdOutput,
  getLastAlsoMatched,
} from '../src/server/dailyBrief.js';
import type { DailyBrief, BriefAd } from '../src/server/dailyBrief.js';
import type { ParsedUtterance } from '../src/shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIEF_PATH = resolve(__dirname, '..', 'data', 'ep-2275-brief.json');

// ─── Load brief ───────────────────────────────────────────────────────
const brief: DailyBrief = JSON.parse(readFileSync(BRIEF_PATH, 'utf-8'));
loadBrief(brief);

// ─── Build 20 synthetic utterances rotating through all trigger keywords ──
const allTriggers: Array<{ ad: BriefAd; trigger: string }> = [];
for (const ad of brief.ads) {
  for (const t of ad.triggers) {
    allTriggers.push({ ad, trigger: t });
  }
}

const UTTERANCE_TEMPLATES = [
  (kw: string) => `Yeah so we finally hired someone to handle ${kw} because it was killing us`,
  (kw: string) => `The biggest challenge for early stage is definitely ${kw}`,
  (kw: string) => `I mean when you look at ${kw} costs for a 10-person startup it's insane`,
  (kw: string) => `We spent three months trying to figure out ${kw} before giving up and outsourcing`,
  (kw: string) => `Every founder I talk to says ${kw} is the thing they wish they'd solved earlier`,
];

interface TimedUtterance {
  utterance: ParsedUtterance;
  triggerKeyword: string;
}

const utterances: TimedUtterance[] = [];
for (let i = 0; i < 20; i++) {
  const { trigger } = allTriggers[i % allTriggers.length];
  const template = UTTERANCE_TEMPLATES[i % UTTERANCE_TEMPLATES.length];
  utterances.push({
    utterance: {
      speaker: i % 2 === 0 ? 'you' : 'them',
      text: template(trigger),
      timestamp: Date.now() + i * 1000,
      id: `utt_latency_${String(i).padStart(3, '0')}`,
    },
    triggerKeyword: trigger,
  });
}

// ─── Run 20 sequential calls, collect timings ─────────────────────────
const timings: number[] = [];

async function main() {
  console.log(`[measure] Brief: episode ${brief.episode}, ${brief.ads.length} ads`);
  console.log(`[measure] Running 20 sequential Not Ad calls...\n`);

  for (let i = 0; i < utterances.length; i++) {
    const { utterance } = utterances[i];

    // Reset dedupe so every call fires (set last-fired to 0 by re-loading brief)
    loadBrief(brief);

    // checkBrief sets lastMatchedTrigger in module state
    const matchedAd = checkBrief(utterance.text);
    if (!matchedAd) {
      console.warn(`[measure] No match for "${utterance.text.slice(0, 50)}…" — skipping`);
      continue;
    }
    const alsoMatched = getLastAlsoMatched();
    const recent: ParsedUtterance[] = utterances.slice(Math.max(0, i - 3), i + 1).map(u => u.utterance);

    const label = `notAd-${utterance.id}`;
    const t0 = performance.now();
    console.time(label);
    try {
      const result = await generateNotAdOutput(matchedAd, recent, alsoMatched);
      console.timeEnd(label);
      const elapsed = performance.now() - t0;
      timings.push(elapsed);
      console.log(`  → ${matchedAd.sponsor} | "${(result?.personality_bubble ?? '').slice(0, 60)}…"\n`);
    } catch (err) {
      console.timeEnd(label);
      const elapsed = performance.now() - t0;
      timings.push(elapsed);
      console.warn(`  → ERROR: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  // ─── Percentiles ──────────────────────────────────────────────────
  if (timings.length === 0) {
    console.error('\n[measure] No successful calls. Check CLOUD_API_KEY / ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  timings.sort((a, b) => a - b);
  const pct = (p: number) => timings[Math.max(0, Math.ceil(timings.length * p) - 1)];

  console.log('═══════════════════════════════════════');
  console.log(`count: ${timings.length}`);
  console.log(`p50:   ${pct(0.50).toFixed(0)}ms`);
  console.log(`p75:   ${pct(0.75).toFixed(0)}ms`);
  console.log(`p90:   ${pct(0.90).toFixed(0)}ms`);
  console.log(`max:   ${pct(1.0).toFixed(0)}ms`);
  console.log('═══════════════════════════════════════');
}

main().catch((err) => {
  console.error('[measure] Fatal:', err);
  process.exit(1);
});
