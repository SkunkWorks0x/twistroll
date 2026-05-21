// Replay test for the four Ep 2285 Docket failures (Fix #1 gate).
//
// Each case previously came back UNVERIFIABLE / null despite Tavily returning
// at least one topical Tier-2 source. The fix loosens the PARTIAL pathway and
// adds product/platform-statistic few-shot examples (Examples 14, 15).
//
// Pass criteria: ≥3 of 4 must flip from UNVERIFIABLE/null to PARTIAL or TRUE
// with ≥1 citation.

import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import { retrieve, formatForDocket } from '../src/server/retrieval.js';
import { runDocket } from '../src/server/synthesis.js';
import type { ClaimClassification, TranscriptSegment } from '../src/shared/types.js';

loadEnv();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set in .env — Docket needs Haiku.');
  process.exit(1);
}

function makeClaim(opts: {
  claimText: string;
  primaryEntity: string;
  entityType: ClaimClassification['entityType'];
  claimType: ClaimClassification['claimType'];
  keyNumbers: string[];
  searchableNoun: string;
  speaker: 'host' | 'cohost' | 'guest';
}): ClaimClassification {
  const id = randomUUID();
  const speakerNumber = opts.speaker === 'host' ? 0 : opts.speaker === 'cohost' ? 1 : 2;
  return {
    isClaim: true,
    claimText: opts.claimText,
    speaker: opts.speaker,
    speakerNumber,
    confidence: 0.9,
    reason: 'replay fixture',
    segmentId: id,
    timestamp: 0,
    primaryEntity: opts.primaryEntity,
    entityType: opts.entityType,
    keyNumbers: opts.keyNumbers,
    claimType: opts.claimType,
    searchableNoun: opts.searchableNoun,
    claimSpan: { startSegmentId: id, endSegmentId: id },
  };
}

function makeSeg(speaker: number, text: string, t: number): TranscriptSegment {
  return {
    id: randomUUID(),
    text,
    speaker,
    speakerLabel: `Speaker ${speaker}`,
    timestamp: t,
    duration: 2,
    isFinal: true,
    confidence: 1,
    createdAt: Date.now(),
  };
}

const RECENT: TranscriptSegment[] = [
  makeSeg(0, 'Walk me through the product.', 0),
  makeSeg(2, 'Sure — happy to give the tour.', 3),
  makeSeg(0, 'Hit the headline numbers.', 6),
];

interface TestCase {
  label: string;
  failureMode: string;
  claim: ClaimClassification;
}

// Fixtures from the live Ep 2285 run (2026-05-06) — claims that came back
// UNVERIFIABLE/null despite topical Tavily sources.
const TESTS: TestCase[] = [
  {
    label: '#1 Nanogram availability (guest, product)',
    failureMode: 'product-availability + tech-press coverage → previously UNVERIFIABLE',
    claim: makeClaim({
      claimText: 'Nanogram is available right now.',
      primaryEntity: 'Nanogram',
      entityType: 'product',
      claimType: 'unknown',
      keyNumbers: [],
      searchableNoun: 'Nanogram product launch app',
      speaker: 'guest',
    }),
  },
  {
    label: '#2 Render 5M developers (guest, platform-statistic)',
    failureMode: 'platform user-count claim with company/press coverage → previously UNVERIFIABLE',
    claim: makeClaim({
      claimText: 'Render has 5,000,000 developers already using the platform.',
      primaryEntity: 'Render',
      entityType: 'company',
      claimType: 'financial',
      keyNumbers: ['5,000,000', '5M'],
      searchableNoun: 'Render developers platform users',
      speaker: 'guest',
    }),
  },
  {
    label: '#3 LinkedIn billion users (guest, platform-statistic)',
    failureMode: 'Tavily timed out in original log → expected to suppress (0 sources)',
    claim: makeClaim({
      claimText: 'There are a billion people using LinkedIn.',
      primaryEntity: 'LinkedIn',
      entityType: 'company',
      claimType: 'financial',
      keyNumbers: ['1 billion', 'billion'],
      searchableNoun: 'LinkedIn users members billion',
      speaker: 'guest',
    }),
  },
  {
    label: '#4 every.io 200 countries (guest, platform-availability)',
    failureMode: 'platform reach claim with adjacent press → previously UNVERIFIABLE',
    claim: makeClaim({
      claimText: 'every.io can help founders hire contractors in over 200 countries.',
      primaryEntity: 'every.io',
      entityType: 'company',
      claimType: 'unknown',
      keyNumbers: ['200', '200 countries'],
      searchableNoun: 'every.io hire contractors countries platform',
      speaker: 'guest',
    }),
  },
];

interface CaseResult {
  label: string;
  failureMode: string;
  retrievedCount: number;
  retrievedTitles: string[];
  retrievedUrls: Set<string>;
  verdict: string;
  citationsCount: number;
  hallucinatedUrls: string[];
  flipped: boolean;
}

(async () => {
  // Warmup LanceDB so case #1 doesn't pay the cold-start hit alone.
  try {
    const { queryMemory } = await import('../src/server/episodeMemory.js');
    await queryMemory('startup product launch platform', 1);
    console.log('[LANCEDB] Warmup complete\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[LANCEDB] Warmup failed: ${msg}\n`);
  }

  console.log(`Running ${TESTS.length} replay-failure cases (Fix #1 gate)…\n`);

  const results: CaseResult[] = [];

  for (const t of TESTS) {
    console.log(`─── ${t.label} ───`);
    console.log(`  claim:       "${t.claim.claimText}"`);
    console.log(`  failureMode: ${t.failureMode}`);

    const r = await retrieve(t.claim);
    const retrievedUrls = new Set(r.merged.map((s) => s.url).filter((u): u is string => !!u));
    console.log(`  retrieve:    lance=${r.lance.length} tavily=${r.tavily.length} grok=${r.grokipedia.length} merged=${r.merged.length}  total=${r.timing.total}ms`);
    r.merged.slice(0, 6).forEach((s, i) =>
      console.log(`    [${i + 1}] tier${s.tier} ${s.type}  | ${s.title}${s.url ? '  ' + s.url : ''}`)
    );

    const formatted = formatForDocket(r.merged, t.claim, RECENT);
    const docketRes = await runDocket(t.claim, r.merged, formatted);
    const docket = docketRes.output;

    if (!docket) {
      console.log(`  DOCKET: null (suppressed${r.merged.length === 0 ? ' — 0 sources' : ''})`);
      results.push({
        label: t.label,
        failureMode: t.failureMode,
        retrievedCount: r.merged.length,
        retrievedTitles: r.merged.map((s) => s.title),
        retrievedUrls,
        verdict: 'null',
        citationsCount: 0,
        hallucinatedUrls: [],
        flipped: false,
      });
      console.log('');
      continue;
    }

    const wExp = docket.explanation.split(/\s+/).filter(Boolean).length;
    const wFu = docket.follow_up.split(/\s+/).filter(Boolean).length;
    console.log(`  DOCKET:      verdict=${docket.verdict}  exp=${wExp}w  fu=${wFu}w  cites=${docket.citations.length}  synth=${docketRes.ms}ms`);
    console.log(`    explanation: ${docket.explanation}`);
    console.log(`    follow-up:   ${docket.follow_up}`);

    const hallucinated: string[] = [];
    docket.citations.forEach((c, i) => {
      const inRetrieval = retrievedUrls.has(c.url);
      const isLanceArchive = !c.url || c.url === 'null' || c.title.toLowerCase().includes('twist ep');
      const ok = inRetrieval || isLanceArchive;
      console.log(`    cite[${i + 1}] tier${c.tier} ${ok ? '✓' : '✗ HALLUCINATED'}  | ${c.title}${c.url ? '  ' + c.url : ''}`);
      if (!ok) hallucinated.push(c.url);
    });

    // A "flip" = went from UNVERIFIABLE/null in the original failing run to
    // PARTIAL or TRUE with ≥1 citation here.
    const flipped =
      (docket.verdict === 'PARTIAL' || docket.verdict === 'TRUE') && docket.citations.length >= 1;

    results.push({
      label: t.label,
      failureMode: t.failureMode,
      retrievedCount: r.merged.length,
      retrievedTitles: r.merged.map((s) => s.title),
      retrievedUrls,
      verdict: docket.verdict,
      citationsCount: docket.citations.length,
      hallucinatedUrls: hallucinated,
      flipped,
    });
    console.log('');
  }

  console.log('─── Summary ──────────────────────────');
  const flippedCount = results.filter((r) => r.flipped).length;
  const totalHallucinated = results.reduce((s, r) => s + r.hallucinatedUrls.length, 0);
  const verdictDist: Record<string, number> = {};
  for (const r of results) verdictDist[r.verdict] = (verdictDist[r.verdict] ?? 0) + 1;
  console.log(`Flipped to PARTIAL/TRUE+citation: ${flippedCount} / ${TESTS.length}`);
  console.log(`Verdict distribution:             ${Object.entries(verdictDist).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`Hallucinated URLs:                ${totalHallucinated}`);
  for (const r of results) {
    console.log(`  ${r.flipped ? '✓ FLIP' : '✗ stay'}  ${r.label} → ${r.verdict} (${r.citationsCount} cites, ${r.retrievedCount} sources)`);
  }
  console.log('──────────────────────────────────────');
  console.log(`Gate: ≥3/4 must flip with ≥1 citation. Result: ${flippedCount}/4. ${flippedCount >= 3 ? 'PASS' : 'FAIL'}`);

  process.exit(flippedCount >= 3 && totalHallucinated === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Replay runner crashed:', err);
  process.exit(1);
});
