// Unit-style assertions for the Pattern Recognizer word-limit constant +
// schema + truncate helper (Fix #3). Mirrors scripts/test-tavily-query.ts —
// manual asserts, console output, process.exit(1) on failure.
//
// Verification path: npx tsx scripts/test-pattern-word-limits.ts

import { config as loadEnv } from 'dotenv';
import {
  PATTERN_WORD_LIMITS,
  PatternSchema,
  truncateToWordLimit,
} from '../src/server/synthesis.js';

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

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

console.log('Pattern word limits — unit assertions\n');

// ─── Test 1 — Constant values are sane ─────────────────────────────────
console.log('Test 1 — PATTERN_WORD_LIMITS values + ordering invariant');
{
  assert('targetMin === 22', PATTERN_WORD_LIMITS.targetMin === 22);
  assert('targetMax === 28', PATTERN_WORD_LIMITS.targetMax === 28);
  assert('hardMax === 32', PATTERN_WORD_LIMITS.hardMax === 32);
  assert('targetMax < hardMax (overshoot tolerance)', PATTERN_WORD_LIMITS.targetMax < PATTERN_WORD_LIMITS.hardMax);
}

// ─── Test 2 — PatternSchema rejects above hardMax ──────────────────────
console.log('\nTest 2 — PatternSchema rejects 33-word string (above 32 hardMax)');
{
  const text33 = Array.from({ length: 33 }, (_, i) => `w${i + 1}`).join(' ');
  console.log(`      input wordCount: ${wordCount(text33)}`);
  const result = PatternSchema.safeParse({ text: text33 });
  assert('safeParse fails (success === false)', !result.success);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join('; ');
    console.log(`      error message: ${messages}`);
    assert('error message contains "32 words"', messages.includes('32 words'));
  } else {
    assert('error message contains "32 words"', false);
  }
}

// ─── Test 3 — PatternSchema accepts at hardMax (32) ────────────────────
console.log('\nTest 3 — PatternSchema accepts 32-word string (at hardMax)');
{
  const text32 = Array.from({ length: 32 }, (_, i) => `w${i + 1}`).join(' ');
  console.log(`      input wordCount: ${wordCount(text32)}`);
  const result = PatternSchema.safeParse({ text: text32 });
  assert('safeParse succeeds at hardMax', result.success === true);
}

// ─── Test 4 — PatternSchema accepts in target band ─────────────────────
console.log('\nTest 4 — PatternSchema accepts 25-word string (in target band)');
{
  const text25 = Array.from({ length: 25 }, (_, i) => `w${i + 1}`).join(' ');
  console.log(`      input wordCount: ${wordCount(text25)}`);
  const result = PatternSchema.safeParse({ text: text25 });
  assert('safeParse succeeds in target band', result.success === true);
}

// ─── Test 5 — truncateToWordLimit caps at hardMax ──────────────────────
console.log('\nTest 5 — truncateToWordLimit(60-word text, hardMax) caps to ≤ 32');
{
  // 60 words across 4 sentences (15 words each), so sentence-aware truncation
  // can find a complete-sentence stopping point.
  const sentence = (idx: number) =>
    `Sentence ${idx} word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13.`;
  const text60 = [sentence(1), sentence(2), sentence(3), sentence(4)].join(' ');
  console.log(`      input wordCount: ${wordCount(text60)}`);
  const result = truncateToWordLimit(text60, PATTERN_WORD_LIMITS.hardMax);
  console.log(`      truncated: ${result.truncated}, from: ${result.from}, to: ${result.to}`);
  assert('truncated === true', result.truncated === true);
  assert('result.to <= hardMax (32)', result.to <= PATTERN_WORD_LIMITS.hardMax);
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
