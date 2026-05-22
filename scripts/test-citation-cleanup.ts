// Unit tests for stripHallucinatedCitations — the URL strip + ref renumber
// stage of Docket post-processing. Pure function, no Haiku / no network.
// Style mirrors test-injection-guardrails.ts.

import { stripHallucinatedCitations } from '../src/server/synthesis.js';
import type { DocketOutput } from '../src/server/synthesis.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq<T>(label: string, expected: T, actual: T): void {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
    failed++;
    failures.push(label);
  }
}

function makeCandidate(overrides: Partial<DocketOutput>): DocketOutput {
  return {
    grounding: 'placeholder grounding',
    verdict: 'TRUE',
    explanation: 'placeholder explanation',
    citations: [],
    ...overrides,
  };
}

console.log('Citation cleanup — unit assertions\n');

// ─── Scenario 1 — [1] valid + [2] hallucinated → keep [1], drop [2] ─────
console.log('Scenario 1 — [1] valid + [2] hallucinated → keep [1], drop [2]');
{
  const candidate = makeCandidate({
    verdict: 'TRUE',
    explanation: 'Source A [1] and source B [2] both confirm.',
    grounding: 'Source A [1] and source B [2] confirm the figure.',
    citations: [
      { title: 'Source A', url: 'https://a.example.com', tier: 1 },
      { title: 'Source B', url: 'https://hallucinated.example.com', tier: 2 },
    ],
  });
  const validUrls = new Set(['https://a.example.com']);
  const result = stripHallucinatedCitations(candidate, validUrls);
  assertEq('1 citation survives', 1, result.citations.length);
  assertEq('surviving citation is Source A', 'Source A', result.citations[0]?.title);
  assertEq('explanation references [1] only — no dangling [2]', 'Source A [1] and source B both confirm.', result.explanation);
  assertEq('grounding references [1] only — no dangling [2]', 'Source A [1] and source B confirm the figure.', result.grounding);
  assertEq('verdict unchanged', 'TRUE', result.verdict);
}

// ─── Scenario 2 — [1] hallucinated + [2] valid → renumber [2] → [1] ─────
console.log('\nScenario 2 — [1] hallucinated + [2] valid → renumber [2] → [1]');
{
  const candidate = makeCandidate({
    verdict: 'PARTIAL',
    explanation: 'Source A [1] and source B [2] addressed the topic.',
    grounding: 'Source B [2] is the primary citation.',
    citations: [
      { title: 'Source A', url: 'https://hallucinated.example.com', tier: 1 },
      { title: 'Source B', url: 'https://b.example.com', tier: 2 },
    ],
  });
  const validUrls = new Set(['https://b.example.com']);
  const result = stripHallucinatedCitations(candidate, validUrls);
  assertEq('1 citation survives', 1, result.citations.length);
  assertEq('surviving citation is Source B', 'Source B', result.citations[0]?.title);
  assertEq('explanation: [1] dropped, [2] renumbered to [1]', 'Source A and source B [1] addressed the topic.', result.explanation);
  assertEq('grounding: [2] renumbered to [1]', 'Source B [1] is the primary citation.', result.grounding);
}

// ─── Scenario 3 — all hallucinated + verdict requires evidence → UNVERIFIABLE ─
console.log('\nScenario 3 — all citations hallucinated + verdict=TRUE → downgrade to UNVERIFIABLE');
{
  const candidate = makeCandidate({
    verdict: 'TRUE',
    explanation: 'Source A confirms the figure [1].',
    citations: [{ title: 'Source A', url: 'https://hallucinated.example.com', tier: 1 }],
  });
  const validUrls = new Set<string>();
  const result = stripHallucinatedCitations(candidate, validUrls);
  assertEq('0 citations', 0, result.citations.length);
  assertEq('downgraded to UNVERIFIABLE', 'UNVERIFIABLE', result.verdict);
  assertEq('canonical absence phrase set', 'No primary source located in show archive or live retrieval.', result.explanation);
}

// ─── Scenario 4 — null-URL citation (LanceDB archive) passes through ────
console.log('\nScenario 4 — null-URL archive citation passes through unchanged');
{
  const candidate = makeCandidate({
    verdict: 'PARTIAL',
    explanation: 'Archive episode covered this topic [1].',
    grounding: 'TWiST Ep 9999 [1] covers this.',
    citations: [{ title: 'TWiST Ep 9999', url: null, tier: 1 }],
  });
  const validUrls = new Set<string>();
  const result = stripHallucinatedCitations(candidate, validUrls);
  assertEq('null-URL citation survives', 1, result.citations.length);
  assertEq('explanation unchanged', 'Archive episode covered this topic [1].', result.explanation);
  assertEq('grounding unchanged', 'TWiST Ep 9999 [1] covers this.', result.grounding);
  assertEq('verdict unchanged', 'PARTIAL', result.verdict);
}

// ─── Scenario 5 — no hallucinations → no-op fast path ───────────────────
console.log('\nScenario 5 — all citations valid → unchanged');
{
  const candidate = makeCandidate({
    verdict: 'TRUE',
    explanation: 'Source A [1] confirms.',
    citations: [{ title: 'Source A', url: 'https://a.example.com', tier: 1 }],
  });
  const validUrls = new Set(['https://a.example.com']);
  const result = stripHallucinatedCitations(candidate, validUrls);
  assertEq('citation preserved', 1, result.citations.length);
  assertEq('explanation unchanged', 'Source A [1] confirms.', result.explanation);
}

console.log('\n──────────────────────────────────');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log('──────────────────────────────────');

process.exit(failed === 0 ? 0 : 1);
