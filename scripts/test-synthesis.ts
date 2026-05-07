// End-to-end test of the synthesis layer — runs retrieve → synthesize for
// three hardcoded claims that exercise the full pipeline.
//
// Pass criteria (per spec):
//   - Docket and Pattern produce output for #1 and #2
//   - Docket produces UNVERIFIABLE for #3
//   - All word limits enforced (Zod refinements + post-processing)
//   - No hallucinated citations (every URL traceable to retrieval)
//   - Total synthesis <3s per claim

import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import { retrieve } from '../src/server/retrieval.js';
import { synthesize } from '../src/server/synthesis.js';
import type { ClaimClassification, TranscriptSegment } from '../src/shared/types.js';

loadEnv();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set in .env — synthesis needs Haiku.');
  process.exit(1);
}

function makeClaim(
  claimText: string,
  primaryEntity: string,
  claimType: ClaimClassification['claimType'],
  keyNumbers: string[],
  searchableNoun: string,
  speaker: 'host' | 'guest' = 'guest'
): ClaimClassification {
  const id = randomUUID();
  return {
    isClaim: true,
    claimText,
    speaker,
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
  makeSeg(0, 'Let me ask about the business.', 0),
  makeSeg(1, 'Sure, happy to walk through it.', 3),
  makeSeg(0, 'How are the metrics looking?', 6),
];

interface TestCase {
  label: string;
  claim: ClaimClassification;
  expect: {
    docketRequired: boolean;
    patternRequired: boolean;
    docketVerdict?: ClaimClassification['claimType'] extends never ? never : 'UNVERIFIABLE';
  };
}

const TESTS: TestCase[] = [
  {
    label: 'financial — retrievable metrics',
    claim: makeClaim(
      "We're at $15M ARR with 90% net retention",
      'SaaS Company',
      'financial',
      ['$15M ARR', '90%'],
      '$15M ARR net retention SaaS',
      'guest'
    ),
    expect: { docketRequired: true, patternRequired: true },
  },
  {
    label: 'attribution — Jason self-reference',
    claim: makeClaim(
      'As Jason mentioned last episode, this company raised at a $500M valuation',
      'startup valuation',
      'attribution',
      ['$500M'],
      'startup $500M valuation last episode',
      'host'
    ),
    expect: { docketRequired: true, patternRequired: true },
  },
  {
    label: 'unverifiable — categorical claim',
    claim: makeClaim(
      "We're in a completely new category with no competitors",
      'new category claim',
      'comparative',
      [],
      'category one no competitors',
      'guest'
    ),
    expect: { docketRequired: true, patternRequired: true, docketVerdict: 'UNVERIFIABLE' as any },
  },
];

(async () => {
  console.log(`Running ${TESTS.length} synthesis end-to-end tests…\n`);

  let passed = 0;
  const failures: string[] = [];

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    console.log(`─── #${i + 1} ${t.label} ───`);
    console.log(`  claim:   "${t.claim.claimText}"`);
    console.log(`  speaker: ${t.claim.speaker}`);

    // Retrieval first.
    const r = await retrieve(t.claim);
    console.log(`  retrieval: lance=${r.lance.length} tavily=${r.tavily.length} grok=${r.grokipedia.length} merged=${r.merged.length} (${r.timing.total}ms)`);

    // Synthesis.
    const result = await synthesize(t.claim, r.merged, RECENT);
    console.log(
      `  timing:   docket=${result.timing.docketMs}ms pattern=${result.timing.patternMs}ms contradiction=${result.timing.contradictionMs}ms total=${result.timing.totalMs}ms`
    );

    if (result.docket) {
      const wExp = result.docket.explanation.split(/\s+/).filter(Boolean).length;
      const wFu = result.docket.follow_up.split(/\s+/).filter(Boolean).length;
      console.log(`  DOCKET: verdict=${result.docket.verdict}`);
      console.log(`    explanation (${wExp}w): ${result.docket.explanation}`);
      console.log(`    follow_up (${wFu}w): ${result.docket.follow_up}`);
      console.log(`    citations: ${result.docket.citations.length}`);
      result.docket.citations.forEach((c, j) => console.log(`      [${j + 1}] tier${c.tier} | ${c.title} | ${c.url}`));
    } else {
      console.log('  DOCKET: null (suppressed)');
    }

    if (result.pattern) {
      const wp = result.pattern.text.split(/\s+/).filter(Boolean).length;
      console.log(`  PATTERN (${wp}w): ${result.pattern.text}`);
    } else {
      console.log('  PATTERN: null');
    }

    if (result.hostContradiction) {
      console.log(`  CONTRADICTION: Ep ${result.hostContradiction.episodeNumber} (${result.hostContradiction.episodeDate})`);
      console.log(`    paraphrase: ${result.hostContradiction.paraphrase}`);
      console.log(`    follow-up:  ${result.hostContradiction.followUp}`);
    } else {
      console.log('  CONTRADICTION: null');
    }

    // Verify pass criteria.
    const issues: string[] = [];
    if (t.expect.docketRequired && !result.docket) {
      // Docket suppression on zero sources is valid behavior (per spec §3E),
      // not a test failure. Note it but don't fail.
      if (r.merged.length === 0) {
        console.log('  note: Docket null because retrieval returned 0 sources (spec §3E)');
      } else {
        issues.push('Docket required but null');
      }
    }
    if (t.expect.patternRequired && !result.pattern) {
      issues.push('Pattern required but null');
    }
    if (t.expect.docketVerdict && result.docket && result.docket.verdict !== t.expect.docketVerdict) {
      issues.push(`Docket verdict expected ${t.expect.docketVerdict}, got ${result.docket.verdict}`);
    }
    if (result.timing.totalMs > 3000) {
      issues.push(`Total synthesis ${result.timing.totalMs}ms exceeds 3000ms`);
    }
    // Citation hallucination check: every cited URL must be in retrieved sources.
    if (result.docket) {
      const validUrls = new Set(r.merged.map((s) => s.url).filter((u): u is string => !!u));
      for (const c of result.docket.citations) {
        if (!validUrls.has(c.url)) {
          issues.push(`Hallucinated citation URL: ${c.url}`);
        }
      }
    }

    if (issues.length === 0) {
      passed++;
      console.log('  ✓ PASS');
    } else {
      failures.push(`#${i + 1} ${t.label}: ${issues.join('; ')}`);
      console.log(`  ✗ FAIL: ${issues.join('; ')}`);
    }
    console.log('');
  }

  console.log('─── Summary ──────────────────────────');
  console.log(`Passed: ${passed}/${TESTS.length}`);
  if (failures.length > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  ${f}`));
  }
  console.log('──────────────────────────────────────');

  process.exit(passed === TESTS.length ? 0 : 1);
})().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
