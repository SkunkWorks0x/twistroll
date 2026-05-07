// Drift guard for the PATTERN_SYSTEM few-shot example OUTPUTs.
// Parses the prompt, extracts each Example N's OUTPUT, asserts the word
// count is in [PATTERN_WORD_LIMITS.targetMin, PATTERN_WORD_LIMITS.targetMax].
// If any future edit pushes an example outside the band, this fails.
//
// Verification path: npx tsx scripts/verify-pattern-fewshots.ts

import { config as loadEnv } from 'dotenv';
import {
  PATTERN_SYSTEM,
  PATTERN_WORD_LIMITS,
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

console.log('Pattern few-shot drift guard — verifying all 7 OUTPUTs in target band\n');

// Split on the Example N header. sections[0] is preamble; sections[1..7] are
// example bodies (CLAIM + OUTPUT lines).
const sections = PATTERN_SYSTEM.split(/\n\nExample \d+\n/);
console.log(`Parsed ${sections.length - 1} example sections (expected 7)`);

assert(`section count is 7 (got ${sections.length - 1})`, sections.length - 1 === 7);

const outputs = sections.slice(1).map((section, i) => {
  const outputStart = section.indexOf('OUTPUT: ');
  if (outputStart === -1) {
    throw new Error(`OUTPUT: marker not found in Example ${i + 1} section`);
  }
  return section.slice(outputStart + 'OUTPUT: '.length).trim();
});

console.log('');
outputs.forEach((output, i) => {
  const idx = i + 1;
  const wc = wordCount(output);
  console.log(`Example ${idx} — wordCount: ${wc}`);
  console.log(`      "${output}"`);
  const inBand = wc >= PATTERN_WORD_LIMITS.targetMin && wc <= PATTERN_WORD_LIMITS.targetMax;
  assert(
    `Example ${idx} wordCount (${wc}) is in [${PATTERN_WORD_LIMITS.targetMin}, ${PATTERN_WORD_LIMITS.targetMax}]`,
    inBand
  );
  console.log('');
});

console.log('──────────────────────────────────');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log('──────────────────────────────────');

process.exit(failed === 0 ? 0 : 1);
