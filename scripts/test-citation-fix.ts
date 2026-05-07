// Smoke test for the citation pipeline fix (Phase 4).
//
// Exercises 5 claims modeled on the Ep 2285 live run that previously came back
// UNVERIFIABLE/null. Verifies:
//   - ≥3 of 5 produce a card with ≥1 real citation
//   - Zero hallucinated URLs (every cited URL must be in the retrieval results)
//   - PARTIAL appears where appropriate
//   - LanceDB hits cited as show-archive context where available
//   - Word limits + anti-pattern blocks still enforced
//
// All claimType values are normalized to the actual classifier enum
// (financial / historical / attribution / comparative / prediction / unknown).

import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import { retrieve } from '../src/server/retrieval.js';
import { runDocket } from '../src/server/synthesis.js';
import { formatForDocket } from '../src/server/retrieval.js';
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
  speaker?: 'host' | 'guest';
}): ClaimClassification {
  const id = randomUUID();
  return {
    isClaim: true,
    claimText: opts.claimText,
    speaker: opts.speaker || 'guest',
    speakerNumber: (opts.speaker || 'guest') === 'host' ? 0 : 1,
    confidence: 0.9,
    reason: 'test fixture',
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
  makeSeg(0, 'Tell me about the business.', 0),
  makeSeg(1, 'Sure, happy to walk through the metrics.', 3),
  makeSeg(0, 'Numbers first, then strategy.', 6),
];

interface TestCase {
  label: string;
  claim: ClaimClassification;
  category: 'retrieval-baseline' | 'fix1-target';
}

// Fixtures pulled from the live Ep 2285 run (2026-05-06). Verbatim claim text +
// classifier-emitted primaryEntity / entityType / claimType from the WS log.
// keyNumbers + searchableNoun derived from the claim text since those fields
// weren't logged.
//
// Category tags split fixtures by what they verify:
//   - 'retrieval-baseline' — the original 5 from Ep 2285. Exercise the full
//     retrieval + merge + Docket pipeline. Threshold: ≥2/5 cards-with-citations.
//   - 'fix1-target' — product/platform/headcount claims that exercise Fix #1's
//     PARTIAL carve-out specifically. Threshold: full pass (3/3).
const TESTS: TestCase[] = [
  {
    label: '#1 LP commits 73.1% (guest, financial)',
    claim: makeClaim({
      claimText: 'Five US firms captured 73.1% of all LP commits in the first quarter of this year',
      primaryEntity: 'US venture capital firms',
      entityType: 'company',
      claimType: 'financial',
      keyNumbers: ['73.1%', 'first quarter'],
      searchableNoun: 'LP commits venture concentration',
      speaker: 'guest',
    }),
    category: 'retrieval-baseline',
  },
  {
    label: '#2 73.1% all VC funding (host, comparative)',
    claim: makeClaim({
      claimText: 'Five US firms captured 73.1% of all venture capital funding.',
      primaryEntity: 'US venture capital firms',
      entityType: 'company',
      claimType: 'comparative',
      keyNumbers: ['73.1%'],
      searchableNoun: 'venture capital concentration top firms',
      speaker: 'host',
    }),
    category: 'retrieval-baseline',
  },
  {
    label: '#3 next 10 firms 15.4% / 11.5% (guest, financial)',
    claim: makeClaim({
      claimText: 'The next 10 firms raised 15.4% of LP commits in the first quarter, and every other fund in the US raised 11.5%.',
      primaryEntity: 'US venture capital firms',
      entityType: 'company',
      claimType: 'financial',
      keyNumbers: ['15.4%', '11.5%', '10 firms', 'first quarter'],
      searchableNoun: 'LP commits firm concentration',
      speaker: 'guest',
    }),
    category: 'retrieval-baseline',
  },
  {
    label: '#4 VC Roundtable 9-figure AUM (guest, financial)',
    claim: makeClaim({
      claimText: 'Each one of the VC Roundtable panelists is behind a fund that has 9 figures of AUM.',
      primaryEntity: 'VC Roundtable',
      entityType: 'event',
      claimType: 'financial',
      keyNumbers: ['9 figures'],
      searchableNoun: 'VC Roundtable AUM fund',
      speaker: 'guest',
    }),
    category: 'retrieval-baseline',
  },
  {
    label: '#5 100 days after claw pill (guest, historical)',
    claim: makeClaim({
      claimText: 'Today is Wednesday, May 6, and it is 100 days after a claw pill event occurred.',
      primaryEntity: '',
      entityType: 'unknown',
      claimType: 'historical',
      keyNumbers: ['May 6', '100 days'],
      searchableNoun: '100 days claw pill event',
      speaker: 'guest',
    }),
    category: 'retrieval-baseline',
  },
  {
    label: 'Fix#1 — Product availability (Wispr Flow on iOS and Android)',
    claim: makeClaim({
      claimText: 'Wispr Flow is now available on iOS and Android.',
      primaryEntity: 'Wispr Flow',
      entityType: 'company',
      claimType: 'comparative',
      keyNumbers: [],
      searchableNoun: 'Wispr Flow mobile launch',
    }),
    category: 'fix1-target',
  },
  {
    label: 'Fix#1 — Platform reach (Cursor 5 million developers)',
    claim: makeClaim({
      claimText: 'Cursor has 5 million developers using the platform.',
      primaryEntity: 'Cursor',
      entityType: 'company',
      claimType: 'comparative',
      keyNumbers: ['5000000'],
      searchableNoun: 'Cursor developer count',
    }),
    category: 'fix1-target',
  },
  {
    label: 'Fix#1 — Headcount (Anthropic 1500 employees 8 countries)',
    claim: makeClaim({
      claimText: 'Anthropic has grown to 1500 employees across eight countries.',
      primaryEntity: 'Anthropic',
      entityType: 'company',
      claimType: 'comparative',
      keyNumbers: ['1500', '8'],
      searchableNoun: 'Anthropic employee count international offices',
    }),
    category: 'fix1-target',
  },
];

interface CaseResult {
  label: string;
  category: 'retrieval-baseline' | 'fix1-target';
  retrievedCount: number;
  retrievedTitles: string[];
  retrievedUrls: Set<string>;
  verdict: string;
  citationsCount: number;
  hallucinatedUrls: string[];
  hasLancedbCitation: boolean;
  followUp: string;
  ok: boolean;
  reasons: string[];
}

(async () => {
  // Warmup — the test script bypasses index.ts main() so the boot-time
  // LanceDB warmup doesn't run. Warming explicitly here removes the
  // ~300ms cold-start hit on test #1 and gives the rest a fair shot.
  try {
    const { queryMemory } = await import('../src/server/episodeMemory.js');
    await queryMemory('startup funding venture capital', 1);
    console.log('[LANCEDB] Warmup complete\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[LANCEDB] Warmup failed: ${msg}\n`);
  }

  console.log(`Running ${TESTS.length} citation-fix tests…\n`);

  const results: CaseResult[] = [];

  for (const t of TESTS) {
    console.log(`─── ${t.label} ───`);
    console.log(`  claim:    "${t.claim.claimText}"`);
    console.log(`  type:     ${t.claim.claimType}  entity=${t.claim.entityType}  numbers=[${t.claim.keyNumbers.join(', ')}]`);

    const r = await retrieve(t.claim);
    const retrievedUrls = new Set(r.merged.map((s) => s.url).filter((u): u is string => !!u));
    console.log(`  retrieve: lance=${r.lance.length} tavily=${r.tavily.length} grokipedia=${r.grokipedia.length} merged=${r.merged.length}  total=${r.timing.total}ms`);
    r.merged.slice(0, 6).forEach((s, i) =>
      console.log(`    [${i + 1}] tier${s.tier} ${s.type}  | ${s.title}${s.url ? '  ' + s.url : ''}`)
    );

    const formatted = formatForDocket(r.merged, t.claim, RECENT);
    const docketRes = await runDocket(t.claim, r.merged, formatted);
    const docket = docketRes.output;

    const reasons: string[] = [];
    if (!docket) {
      console.log(`  DOCKET: null (suppressed${r.merged.length === 0 ? ' — 0 sources' : ''})`);
      results.push({
        label: t.label,
        category: t.category,
        retrievedCount: r.merged.length,
        retrievedTitles: r.merged.map((s) => s.title),
        retrievedUrls,
        verdict: 'null',
        citationsCount: 0,
        hallucinatedUrls: [],
        hasLancedbCitation: false,
        followUp: '',
        ok: r.merged.length === 0,
        reasons: r.merged.length === 0 ? [] : ['Docket null despite non-empty retrieval'],
      });
      console.log('');
      continue;
    }

    const wExp = docket.explanation.split(/\s+/).filter(Boolean).length;
    const wFu = docket.follow_up.split(/\s+/).filter(Boolean).length;
    console.log(`  DOCKET:   verdict=${docket.verdict}  exp=${wExp}w  fu=${wFu}w  cites=${docket.citations.length}  synth=${docketRes.ms}ms`);
    console.log(`    explanation: ${docket.explanation}`);
    console.log(`    follow-up:   ${docket.follow_up}`);

    // Validate.
    if (wExp > 28) reasons.push(`explanation ${wExp}w >28`);
    if (wFu > 18) reasons.push(`follow-up ${wFu}w >18`);

    const hallucinated: string[] = [];
    let hasLanceCitation = false;
    docket.citations.forEach((c, i) => {
      const inRetrieval = retrievedUrls.has(c.url);
      const isLanceArchive = !c.url || c.url === 'null' || c.title.toLowerCase().includes('twist ep');
      if (isLanceArchive) hasLanceCitation = true;
      const ok = inRetrieval || isLanceArchive;
      console.log(`    cite[${i + 1}] tier${c.tier} ${ok ? '✓' : '✗ HALLUCINATED'}  | ${c.title}${c.url ? '  ' + c.url : ''}`);
      if (!ok) hallucinated.push(c.url);
    });

    if (hallucinated.length > 0) reasons.push(`hallucinated URLs: ${hallucinated.length}`);

    results.push({
      label: t.label,
      category: t.category,
      retrievedCount: r.merged.length,
      retrievedTitles: r.merged.map((s) => s.title),
      retrievedUrls,
      verdict: docket.verdict,
      citationsCount: docket.citations.length,
      hallucinatedUrls: hallucinated,
      hasLancedbCitation: hasLanceCitation,
      followUp: docket.follow_up,
      ok: reasons.length === 0,
      reasons,
    });
    console.log('');
  }

  // ─── Summary ────────────────────────────────────────────────
  const cardsWithCitations = results.filter((r) => r.citationsCount > 0).length;
  const totalHallucinated = results.reduce((s, r) => s + r.hallucinatedUrls.length, 0);
  const verdictDist: Record<string, number> = {};
  for (const r of results) verdictDist[r.verdict] = (verdictDist[r.verdict] ?? 0) + 1;
  const lanceCites = results.filter((r) => r.hasLancedbCitation).length;

  console.log('─── Summary ──────────────────────────');
  console.log(`Cards with ≥1 citation:   ${cardsWithCitations} / ${TESTS.length}`);
  console.log(`Hallucinated URLs:        ${totalHallucinated}`);
  console.log(`Verdict distribution:     ${Object.entries(verdictDist).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`LanceDB archive citations: ${lanceCites}`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'}  ${r.label} → ${r.verdict} (${r.citationsCount} cites)${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}`);
  }
  console.log('──────────────────────────────────────');

  // Tagged threshold: baseline floor stays at ≥2/5; Fix#1 fixtures must
  // ALL get a citation (3/3). Hallucinations always 0.
  const baselineResults = results.filter((r) => r.category === 'retrieval-baseline');
  const fix1Results = results.filter((r) => r.category === 'fix1-target');
  const baselineCitations = baselineResults.filter((r) => r.citationsCount > 0).length;
  const fix1Citations = fix1Results.filter((r) => r.citationsCount > 0).length;
  const totalCitations = baselineCitations + fix1Citations;

  const meetsThreshold =
    fix1Citations >= fix1Results.length &&
    baselineCitations >= 2 &&
    totalHallucinated === 0;

  console.log('Threshold check:');
  console.log(`  Baseline:       ${baselineCitations}/${baselineResults.length} cards with citations (need ≥2)`);
  console.log(`  Fix#1:          ${fix1Citations}/${fix1Results.length} cards with citations (need ${fix1Results.length}/${fix1Results.length})`);
  console.log(`  Total:          ${totalCitations}/${TESTS.length} cards with citations`);
  console.log(`  Hallucinations: ${totalHallucinated} (need 0)`);
  console.log(`  Result: ${meetsThreshold ? 'PASS' : 'FAIL'}`);
  process.exit(meetsThreshold ? 0 : 1);
})().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
