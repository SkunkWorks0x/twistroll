// Unit-style assertions for the LanceDB post-processor injection guardrails
// (Step 2 of the retrieval surgical fix). Mirrors scripts/test-tavily-query.ts
// — manual asserts, console output, process.exit(1) on failure.
//
// Verification path: npx tsx scripts/test-injection-guardrails.ts
//
// Tests the pure helper applyLanceDBInjection in isolation — no Haiku, no
// network, no LanceDB. Constructs candidate DocketOutput + synthetic LanceDB
// sources + claim, asserts injection fires or skips per guardrail rules.

import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import { applyLanceDBInjection } from '../src/server/synthesis.js';
import type { DocketOutput } from '../src/server/synthesis.js';
import type { RetrievedSource } from '../src/server/retrieval.js';
import type { ClaimClassification } from '../src/shared/types.js';

loadEnv();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq<T>(label: string, expected: T, actual: T): void {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    console.log(`  ✓ ${label}`);
    console.log(`      got: ${JSON.stringify(actual)}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
    failed++;
    failures.push(label);
  }
}

function makeClaim(primaryEntity: string): ClaimClassification {
  const id = 'seg-' + randomUUID();
  return {
    isClaim: true,
    claimText: `Placeholder claim about ${primaryEntity}.`,
    speaker: 'guest',
    speakerNumber: 2,
    confidence: 0.9,
    reason: 'fixture',
    segmentId: id,
    timestamp: 0,
    primaryEntity,
    entityType: 'company',
    keyNumbers: [],
    claimType: 'unknown',
    searchableNoun: primaryEntity,
    claimSpan: { startSegmentId: id, endSegmentId: id },
  } as ClaimClassification;
}

function makeLanceSource(score: number, content: string): RetrievedSource {
  return {
    id: 'lance_test_' + randomUUID(),
    type: 'lancedb',
    tier: 1,
    title: 'TWiST Ep 9999 (2026-05-01) — Test Episode',
    url: null,
    content,
    score,
    metadata: {
      episodeNumber: 9999,
      episodeDate: '2026-05-01',
      episodeTitle: 'Test Episode',
    },
  };
}

function makeCandidate(verdict: DocketOutput['verdict']): DocketOutput {
  return {
    verdict,
    explanation: 'No primary source located in show archive or live retrieval.',
    citations: [],
    follow_up: 'What is the underlying figure here?',
  };
}

console.log('Injection guardrails — unit assertions\n');

// ─── Scenario 1 — PARTIAL + score 0.50 + overlap → INJECTS ──────────────
console.log('Scenario 1 — PARTIAL + score 0.50 + entity overlap → INJECTS');
{
  const claim = makeClaim('LinkedIn');
  const top = makeLanceSource(0.50, 'Discussion about LinkedIn platform reach and the Microsoft acquisition.');
  const candidate = makeCandidate('PARTIAL');
  const result = applyLanceDBInjection(candidate, [top], claim);
  assertEq('1 citation injected', 1, result.citations.length);
  assertEq('citationSource = post_processor', 'post_processor', result.citations[0]?.citationSource);
  assertEq('injected citation has null url (archive)', null, result.citations[0]?.url);
}

// ─── Scenario 2 — PARTIAL + score 0.42 → BLOCKED by floor ───────────────
console.log('\nScenario 2 — PARTIAL + score 0.42 → BLOCKED by floor (< 0.45)');
{
  const claim = makeClaim('LinkedIn');
  const top = makeLanceSource(0.42, 'Discussion about LinkedIn platform reach and the Microsoft acquisition.');
  const candidate = makeCandidate('PARTIAL');
  const result = applyLanceDBInjection(candidate, [top], claim);
  assertEq('0 citations after block', 0, result.citations.length);
}

// ─── Scenario 3 — PARTIAL + score 0.50 + no overlap → BLOCKED ───────────
console.log('\nScenario 3 — PARTIAL + score 0.50 + no entity-token overlap → BLOCKED');
{
  const claim = makeClaim('LinkedIn');
  // Chunk content does NOT contain "linkedin" — the Deel/SpyGate scenario
  // that motivated this guardrail.
  const top = makeLanceSource(0.50, 'Discussion about Deel growth and SpyGate momentum-as-moat debate.');
  const candidate = makeCandidate('PARTIAL');
  const result = applyLanceDBInjection(candidate, [top], claim);
  assertEq('0 citations after block', 0, result.citations.length);
}

// ─── Scenario 4 — TRUE verdict → NEVER INJECTS ──────────────────────────
console.log('\nScenario 4 — TRUE verdict → NEVER INJECTS regardless of score/overlap');
{
  const claim = makeClaim('LinkedIn');
  const top = makeLanceSource(0.95, 'Discussion about LinkedIn platform reach and the Microsoft acquisition.');
  const candidate = makeCandidate('TRUE');
  const result = applyLanceDBInjection(candidate, [top], claim);
  assertEq('TRUE verdict — 0 injected citations', 0, result.citations.length);
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
