// Smoke test for the retrieval layer. Three claims that exercise all three
// sources. Per-source counts + timing + merged top-3 reported.
//
// Pass criterion (per spec): all three retrievers attempt to fire, merge
// produces ranked results. Individual source failures are acceptable.

import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import { retrieve, getBreakerState } from '../src/server/retrieval.js';
import type { ClaimClassification } from '../src/shared/types.js';

loadEnv();

function makeClaim(
  claimText: string,
  primaryEntity: string,
  claimType: ClaimClassification['claimType'],
  keyNumbers: string[],
  searchableNoun: string
): ClaimClassification {
  const id = randomUUID();
  return {
    isClaim: true,
    claimText,
    speaker: 'guest',
    confidence: 0.9,
    reason: 'test fixture',
    segmentId: id,
    timestamp: 0,
    primaryEntity,
    entityType: 'company',
    keyNumbers,
    claimType,
    searchableNoun,
    claimSpan: { startSegmentId: id, endSegmentId: id },
  };
}

const TESTS: Array<{ label: string; claim: ClaimClassification; expectSource: string }> = [
  {
    label: 'financial growth (Tavily lane)',
    claim: makeClaim(
      "We're growing 200% year over year with $50M ARR",
      'Company Growth',
      'financial',
      ['200%', '$50M ARR'],
      '200% YoY growth ARR'
    ),
    expectSource: 'Tavily should return market/financial data',
  },
  {
    label: 'Jason attribution (LanceDB lane)',
    claim: makeClaim(
      'Jason said last month that AI coding tools are overhyped',
      'AI coding tools',
      'attribution',
      [],
      'AI coding tools overhyped'
    ),
    expectSource: 'LanceDB should return relevant episode chunks',
  },
  {
    label: 'historical entity (Grokipedia lane)',
    claim: makeClaim(
      'Mark Zuckerberg started Facebook in his Harvard dorm room in 2004',
      'Mark Zuckerberg',
      'historical',
      ['2004'],
      'Mark Zuckerberg Facebook founding'
    ),
    expectSource: 'Grokipedia should return entity context',
  },
];

(async () => {
  console.log(`Running ${TESTS.length} retrieval smoke tests…\n`);

  let allFailed = 0;
  let allMergedEmpty = 0;

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    console.log(`─── #${i + 1} ${t.label} ───`);
    console.log(`  claim: "${t.claim.claimText}"`);
    console.log(`  expect: ${t.expectSource}`);
    const r = await retrieve(t.claim);

    console.log(
      `  timing: lance=${r.timing.lancedb}ms, tavily=${r.timing.tavily}ms, grokipedia=${r.timing.grokipedia}ms, total=${r.timing.total}ms`
    );
    console.log(`  lance (${r.lance.length}):`);
    r.lance.forEach((s, j) => console.log(`    [${j + 1}] tier${s.tier} score=${s.score.toFixed(3)} | ${s.title}`));
    console.log(`  tavily (${r.tavily.length}):`);
    r.tavily.forEach((s, j) => console.log(`    [${j + 1}] tier${s.tier} score=${s.score.toFixed(3)} | ${s.title} (${s.metadata.domain ?? '?'})`));
    console.log(`  grokipedia (${r.grokipedia.length}):`);
    r.grokipedia.forEach((s, j) => console.log(`    [${j + 1}] tier${s.tier} | ${s.title} | ${s.content.slice(0, 90)}…`));

    console.log(`  merged top-3 (of ${r.merged.length}):`);
    r.merged.slice(0, 3).forEach((s, j) => console.log(`    [${j + 1}] type=${s.type} tier${s.tier} score=${s.score.toFixed(3)} | ${s.title}`));

    if (r.lance.length === 0 && r.tavily.length === 0 && r.grokipedia.length === 0) allFailed++;
    if (r.merged.length === 0) allMergedEmpty++;
    console.log('');
  }

  console.log('─── Breaker state after run ───');
  console.log(JSON.stringify(getBreakerState(), null, 2));

  console.log('\n─── Summary ──────────────────────────');
  console.log(`tests:                ${TESTS.length}`);
  console.log(`all-source failures:  ${allFailed}`);
  console.log(`empty merged:         ${allMergedEmpty}`);
  console.log('──────────────────────────────────────');

  // Pass: at least 2 of 3 tests produced a non-empty merged result, and not all
  // three retrievers failed for any test. Individual source failures are OK.
  const passed = allFailed === 0 && allMergedEmpty <= 1;
  process.exit(passed ? 0 : 1);
})().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
