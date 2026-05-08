// Unit-style assertions for the Docket corrective-retry helper (Fix #2).
// Mirrors scripts/test-tavily-query.ts — manual asserts, console output,
// process.exit(1) on failure.
//
// Verification path: npx tsx scripts/test-docket-corrective-retry.ts
//
// Tests buildCorrectiveInstruction in isolation. No Haiku, no network.
// Verifies the corrective prompt structure for each failure shape:
//   - explanation overflow only
//   - follow-up overflow only
//   - both overflow simultaneously
//   - defensive: non-string fields don't throw

import { config as loadEnv } from 'dotenv';
import { buildCorrectiveInstruction } from '../src/server/synthesis.js';

loadEnv();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
    failures.push(label);
  }
}

const exp32 = Array.from({ length: 32 }, (_, i) => `word${i + 1}`).join(' ');
const fu22 = Array.from({ length: 22 }, (_, i) => `q${i + 1}`).join(' ');

console.log('Docket corrective-retry — unit assertions\n');

// ─── Test 1 — Explanation overflow ─────────────────────────────────────
console.log('Test 1 — Explanation overflow builds corrective with previous text + word count');
{
  const out = buildCorrectiveInstruction(
    { explanation: exp32, follow_up: 'short ok' },
    'Explanation exceeds 28 words',
    undefined
  );
  console.log(`      output:\n${out}\n`);
  assert('contains "32 words"', out.includes('32 words'));
  assert('contains "28 words or fewer"', out.includes('28 words or fewer'));
  assert('contains literal previous explanation text', out.includes(exp32));
  assert('contains "preserving all citation references"', out.includes('preserving all citation references'));
  assert('contains "Do not change the verdict"', out.includes('Do not change the verdict'));
}

// ─── Test 2 — Follow-up overflow ───────────────────────────────────────
console.log('\nTest 2 — Follow-up overflow builds corrective with previous text + word count');
{
  const out = buildCorrectiveInstruction(
    { explanation: 'ok', follow_up: fu22 },
    undefined,
    'Follow-up exceeds 18 words'
  );
  console.log(`      output:\n${out}\n`);
  assert('contains "22 words"', out.includes('22 words'));
  assert('contains "18 words or fewer"', out.includes('18 words or fewer'));
  assert('contains literal previous follow-up text', out.includes(fu22));
  assert('does NOT contain "verdict" (FU branch should not mention verdict)', !out.includes('verdict'));
}

// ─── Test 3 — Both fail simultaneously ─────────────────────────────────
console.log('\nTest 3 — Both explanation and follow-up overflow');
{
  const out = buildCorrectiveInstruction(
    { explanation: exp32, follow_up: fu22 },
    'Explanation exceeds 28 words',
    'Follow-up exceeds 18 words'
  );
  console.log(`      output:\n${out}\n`);
  assert('contains both prior texts', out.includes(exp32) && out.includes(fu22));
  assert('contains both word counts (32 and 22)', out.includes('32 words') && out.includes('22 words'));
  assert('ends with "Produce the corrected fact_check tool call now."', out.endsWith('Produce the corrected fact_check tool call now.'));
}

// ─── Test 4 — Defensive: non-string fields don't throw ─────────────────
console.log('\nTest 4 — Non-string fields do not throw, output is just closing instruction');
{
  let threw = false;
  let out = '';
  try {
    out = buildCorrectiveInstruction(
      { explanation: undefined, follow_up: 42 },
      'Explanation exceeds 28 words',
      'Follow-up exceeds 18 words'
    );
  } catch {
    threw = true;
  }
  console.log(`      output: "${out}"`);
  assert('does not throw on non-string fields', !threw);
  assert('output equals "Produce the corrected fact_check tool call now."', out === 'Produce the corrected fact_check tool call now.');
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
