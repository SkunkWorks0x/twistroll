// Unit-style assertions for the new Tavily query construction (Step 1 of the
// retrieval surgical fix). Pattern matches scripts/test-citation-fix.ts —
// manual asserts, console output, process.exit(1) on failure. No describe/it
// sugar (codebase has no test runner installed; that's a deliberate scope
// boundary, not an oversight).
//
// Verification path: npx tsx scripts/test-tavily-query.ts

import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import {
  buildTavilyQuery,
  buildTavilyNarrowQuery,
  humanizeNumber,
} from '../src/server/retrieval.js';
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

function makeClaim(
  opts: Partial<ClaimClassification> & { claimText: string; primaryEntity: string }
): ClaimClassification {
  const id = randomUUID();
  return {
    isClaim: true,
    speaker: 'guest',
    speakerNumber: 2,
    confidence: 0.9,
    reason: 'test fixture',
    segmentId: id,
    timestamp: 0,
    entityType: 'company',
    keyNumbers: [],
    claimType: 'unknown',
    searchableNoun: '',
    claimSpan: { startSegmentId: id, endSegmentId: id },
    ...opts,
  } as ClaimClassification;
}

console.log('Tavily query construction — unit assertions\n');

// ─── Scenario 1 — Short entity name quoted in broad query ───
console.log('Scenario 1 — Short entity name quoted in broad query');
{
  const c = makeClaim({
    claimText: 'Render has 5,000,000 developers already using the platform.',
    primaryEntity: 'Render',
    keyNumbers: ['5000000'],
    searchableNoun: 'developers',
    claimType: 'financial',
  });
  const q = buildTavilyQuery(c);
  console.log(`      broad query: ${q}`);
  assertEq('broad query contains literal "Render" (with quotes)', true, q.includes('"Render"'));
}

// ─── Scenario 2 — Numbers humanized ───
console.log('\nScenario 2 — Numbers >= 1M humanized to named magnitude');
{
  assertEq('humanizeNumber("5000000")', '5 million', humanizeNumber('5000000'));
  assertEq('humanizeNumber("1000000000")', '1 billion', humanizeNumber('1000000000'));
  assertEq('humanizeNumber("280000000")', '280 million', humanizeNumber('280000000'));
  assertEq('humanizeNumber("200") passes through (<1M)', '200', humanizeNumber('200'));
  assertEq('humanizeNumber("5,000,000") with commas', '5 million', humanizeNumber('5,000,000'));
}

// ─── Scenario 3 — Year-anchor only on present-tense claims ───
console.log('\nScenario 3 — Year-anchor (2026) appended on present-tense claims, not historical');
{
  const present = makeClaim({
    claimText: 'Render has 5,000,000 developers already using the platform.',
    primaryEntity: 'Render',
    keyNumbers: ['5000000'],
    searchableNoun: 'developers',
    claimType: 'financial',
  });
  const past = makeClaim({
    claimText: 'Render was founded back in 2018 by ex-Heroku engineers.',
    primaryEntity: 'Render',
    keyNumbers: ['2018'],
    searchableNoun: 'founders',
    claimType: 'historical',
  });
  const presentQ = buildTavilyQuery(present);
  const pastQ = buildTavilyQuery(past);
  console.log(`      present-tense query: ${presentQ}`);
  console.log(`      historical query:    ${pastQ}`);
  assertEq('present-tense query ends with " 2026"', true, presentQ.endsWith(' 2026'));
  assertEq('historical query does not contain " 2026"', false, pastQ.includes(' 2026'));
}

// ─── Scenario 4 — claimType tokens dropped ───
console.log('\nScenario 4 — claimType tokens (financial / historical / etc.) dropped from query');
{
  const fc = makeClaim({
    claimText: 'Render has 5,000,000 developers already using the platform.',
    primaryEntity: 'Render',
    keyNumbers: ['5000000'],
    searchableNoun: 'developers',
    claimType: 'financial',
  });
  const q = buildTavilyQuery(fc).toLowerCase();
  console.log(`      broad query (lower): ${q}`);
  assertEq('broad query does NOT contain "financial"', false, q.includes('financial'));
  assertEq('broad query does NOT contain "historical"', false, q.includes('historical'));
  assertEq('broad query does NOT contain "comparative"', false, q.includes('comparative'));
  assertEq('broad query does NOT contain "attribution"', false, q.includes('attribution'));
  assertEq('broad query does NOT contain "prediction"', false, q.includes('prediction'));
}

// ─── Scenario 5 — Narrow query site-scoping ───
console.log('\nScenario 5 — Narrow query site-scoping');
{
  // 5a — entity carries a TLD: every.io
  const everyClaim = makeClaim({
    claimText: 'every.io can help founders hire contractors in over 200 countries.',
    primaryEntity: 'every.io',
    keyNumbers: ['200'],
    searchableNoun: 'contractors countries',
  });
  const everyN = buildTavilyNarrowQuery(everyClaim);
  console.log(`      every.io narrow: domain=${everyN.domain} query="${everyN.query}"`);
  assertEq('every.io domain inferred as itself', 'every.io', everyN.domain);
  assertEq('every.io narrow query starts with "site:every.io"', true, everyN.query.startsWith('site:every.io'));

  // 5b — short single-word entity, no TLD: Render → render.com guess
  const renderClaim = makeClaim({
    claimText: 'Render has 5,000,000 developers already using the platform.',
    primaryEntity: 'Render',
    keyNumbers: ['5000000'],
    searchableNoun: 'developers',
  });
  const renderN = buildTavilyNarrowQuery(renderClaim);
  console.log(`      Render narrow:   domain=${renderN.domain} query="${renderN.query}"`);
  assertEq('Render domain guessed as render.com', 'render.com', renderN.domain);
  assertEq('Render narrow query starts with "site:render.com"', true, renderN.query.startsWith('site:render.com'));

  // 5c — multi-word entity (>2 tokens): no inference, falls back to quoted form
  const longClaim = makeClaim({
    claimText: 'US venture capital firms captured 73.1% of LP commits.',
    primaryEntity: 'US venture capital firms',
    keyNumbers: ['73.1%'],
    searchableNoun: 'concentration LP commits',
  });
  const longN = buildTavilyNarrowQuery(longClaim);
  console.log(`      long-entity narrow: domain=${longN.domain} query="${longN.query}"`);
  assertEq('long entity skips domain inference', null, longN.domain);
  assertEq('long entity narrow query falls back to quoted form', true, longN.query.startsWith('"US venture capital firms"'));
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
