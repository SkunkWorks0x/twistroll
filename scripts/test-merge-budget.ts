// Unit-style assertions for the truncation-aware merge token budget (Phase B
// of cc-retrieval-surgical-fix). Mirrors scripts/test-tavily-query.ts —
// manual asserts, console output, process.exit(1) on failure.
//
// Verification path: npx tsx scripts/test-merge-budget.ts
//
// Tests 1, 2, 3, 5 exercise estimateTokens directly on a single source.
// Test 4 is the integration case — runs mergeAndRank on the realistic 6-source
// production shape (3 lancedb @ ~2800c + 3 tavily @ ~1500c) and verifies the
// full budget loop now lets all 6 survive instead of pruning to 1.

import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import {
  estimateTokens,
  mergeAndRank,
  type RetrievedSource,
} from '../src/server/retrieval.js';

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

function makeTavily(titleLen: number, contentLen: number, idx = 0, score = 0.5): RetrievedSource {
  return {
    id: 'tavily_test_' + randomUUID(),
    type: 'tavily',
    tier: 1,
    title: 'X'.repeat(titleLen),
    url: `https://example-${idx}.com/article-${idx}`,
    content: 'T'.repeat(contentLen),
    score,
    sourceKind: 'transcript',
    evidenceRole: 'primary',
    metadata: {},
  };
}

function makeLance(titleLen: number, contentLen: number, episodeNumber = 1, score = 0.5): RetrievedSource {
  return {
    id: 'lance_test_' + randomUUID(),
    type: 'lancedb',
    tier: 1,
    title: 'X'.repeat(titleLen),
    url: null,
    content: 'L'.repeat(contentLen),
    score,
    sourceKind: 'transcript',
    evidenceRole: 'primary',
    metadata: { episodeNumber, episodeDate: '2026-01-01', episodeTitle: 'Test' },
  };
}

function makeGrok(titleLen: number, contentLen: number): RetrievedSource {
  return {
    id: 'grok_test_' + randomUUID(),
    type: 'grokipedia',
    tier: 2,
    title: 'X'.repeat(titleLen),
    url: null,
    content: 'G'.repeat(contentLen),
    score: 0.5,
    sourceKind: 'transcript',
    evidenceRole: 'primary',
    metadata: {},
  };
}

console.log('Merge token-budget — unit assertions\n');

// ─── Test 1 — Tavily content >200 capped at 200 ────────────────────────
console.log('Test 1 — Tavily 10000c content capped at 200');
{
  const s = makeTavily(1, 10000);
  // ceil((1 + 200) / 4) = 51
  assertEq('estimateTokens(tavily, title=1, content=10000) === 51', 51, estimateTokens(s));
}

// ─── Test 2 — LanceDB content >400 capped at 400 ───────────────────────
console.log('\nTest 2 — LanceDB 10000c content capped at 400');
{
  const s = makeLance(1, 10000);
  // ceil((1 + 400) / 4) = 101
  assertEq('estimateTokens(lancedb, title=1, content=10000) === 101', 101, estimateTokens(s));
}

// ─── Test 3 — Sub-limit content unchanged ──────────────────────────────
console.log('\nTest 3 — Tavily 50c content (under 200 limit) unchanged');
{
  const s = makeTavily(1, 50);
  // ceil((1 + 50) / 4) = 13
  assertEq('estimateTokens(tavily, title=1, content=50) === 13', 13, estimateTokens(s));
}

// ─── Test 4 — Live production shape via mergeAndRank ───────────────────
console.log('\nTest 4 — Live production shape: 3 lancedb @ ~2800c + 3 tavily @ ~1500c → all 6 survive budget');
{
  // 3 lance: distinct episodeNumber AND distinct first-100-chars (prefix-encoded
  // so the lance chunk dedup key `${ep}_${content.slice(0,100)}` fires distinct
  // even on the chance episodeNumber alone weren't enough). Score 0.40-0.50.
  const lance: RetrievedSource[] = [1001, 1002, 1003].map((ep, i) => ({
    id: `lance_test_${ep}_${randomUUID()}`,
    type: 'lancedb' as const,
    tier: 1 as const,
    title: `TWiST Ep ${ep}`,
    url: null,
    // ~2800c with unique first-100 prefix per source.
    content: `Episode ${ep} content prefix: ` + 'L'.repeat(2770),
    score: [0.50, 0.45, 0.40][i],
    sourceKind: 'transcript' as const,
    evidenceRole: 'primary' as const,
    metadata: { episodeNumber: ep, episodeDate: '2026-01-01', episodeTitle: `Test ${ep}` },
  }));
  // 3 tavily: distinct URLs, tier 1, score 0.60-0.70.
  const tavily: RetrievedSource[] = [1, 2, 3].map((idx, i) => ({
    id: `tavily_test_${idx}_${randomUUID()}`,
    type: 'tavily' as const,
    tier: 1 as const,
    title: `Article ${idx}`,
    url: `https://example-${idx}.com/article`,
    content: 'T'.repeat(1500),
    score: [0.70, 0.65, 0.60][i],
    sourceKind: 'transcript' as const,
    evidenceRole: 'primary' as const,
    metadata: {},
  }));
  const merged = mergeAndRank(lance, tavily, []);
  const totalTokens = merged.reduce((sum, s) => sum + estimateTokens(s), 0);
  console.log(`      merged.length: ${merged.length}`);
  console.log(`      totalTokens:   ${totalTokens}`);
  console.log(`      breakdown:     ${merged.map((s) => `${s.type}:${estimateTokens(s)}t`).join(', ')}`);
  assertEq('all 6 sources survive merge (final.length === 6)', 6, merged.length);
  assertEq('totalEstTokens >= 400', true, totalTokens >= 400);
  assertEq('totalEstTokens <= 500', true, totalTokens <= 500);
}

// ─── Test 5 — Grokipedia limit defined (forward-compat) ─────────────────
console.log('\nTest 5 — Grokipedia 10000c content capped at 350');
{
  const s = makeGrok(1, 10000);
  // ceil((1 + 350) / 4) = 88
  assertEq('estimateTokens(grokipedia, title=1, content=10000) === 88', 88, estimateTokens(s));
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
