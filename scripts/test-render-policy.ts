#!/usr/bin/env tsx
// Unit test for the UNVERIFIABLE render policy gate in synthesis.ts.
// Binds to isEmptyAbsence (the predicate the gate calls) so future changes
// to the suppression criterion break this test until updated together.

import { isEmptyAbsence } from '../src/server/synthesis.js';

let passed = 0;
let failed = 0;

function assertEq(label: string, expected: unknown, actual: unknown): void {
  if (expected === actual) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('Render-policy gate — unit assertions\n');

// Case 1: zero-citation UNVERIFIABLE → suppress (no actionable signal for the host).
{
  const zeroCite = {
    grounding: 'No retrieved source addresses the assertion.',
    verdict: 'UNVERIFIABLE' as const,
    explanation: 'No primary source located in show archive or live retrieval.',
    citations: [],
  };
  assertEq('zero-citation UNVERIFIABLE → suppress', true, isEmptyAbsence(zeroCite));
}

// Case 2: one-citation UNVERIFIABLE → render (useful absence — found related
// context that doesn't confirm the specific claim).
{
  const oneCite = {
    grounding: 'Bloomberg [1] covers IPO topic but does not confirm the price range.',
    verdict: 'UNVERIFIABLE' as const,
    explanation: 'Retrieved sources cover IPO filing but not the specific price range [1].',
    citations: [
      {
        title: 'Bloomberg – Cerebras IPO',
        url: 'https://www.bloomberg.com/news/articles/cerebras-ipo',
        tier: 1 as const,
        citationSource: 'haiku' as const,
      },
    ],
  };
  assertEq('one-citation UNVERIFIABLE → render', false, isEmptyAbsence(oneCite));
}

// Sanity: null input → false (nothing to suppress; downstream handles null already).
assertEq('null candidate → false', false, isEmptyAbsence(null));

// Sanity: TRUE/PARTIAL/FALSE/MISLEADING with zero citations → false (policy
// only targets UNVERIFIABLE).
for (const v of ['TRUE', 'FALSE', 'MISLEADING', 'PARTIAL'] as const) {
  assertEq(`${v} with zero citations → render`, false, isEmptyAbsence({
    grounding: 'g',
    verdict: v,
    explanation: 'e',
    citations: [],
  }));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
