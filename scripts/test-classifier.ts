// Smoke test for the claim classifier. Feeds 10 hardcoded test utterances
// and reports accuracy + per-call latency. Test #1 (Jason's self-fact-check
// example) is the gate: if it fails, the core use case is broken.
//
// Usage:
//   npx tsx scripts/test-classifier.ts

import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import { classifySegment } from '../src/server/classifier.js';
import type { TranscriptSegment } from '../src/shared/types.js';

loadEnv();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set in .env — classifier needs the Haiku path.');
  process.exit(1);
}

interface TestCase {
  speaker: 0 | 1;        // 0 = host, 1 = guest
  text: string;
  expected: boolean;
  label: string;
}

const TESTS: TestCase[] = [
  // Should classify as claims (5)
  { speaker: 0, text: "I mentioned this podcast, it was the son Piker and Gia, and she works at The New Yorker", expected: true, label: 'host: name+org (Jason example)' },
  { speaker: 1, text: "We're growing 200% year over year and expect to hit $100M ARR by Q4", expected: true, label: 'guest: 200% YoY + $100M ARR' },
  { speaker: 1, text: "We're the only company doing this in the market", expected: true, label: 'guest: exclusive claim' },
  { speaker: 1, text: "We raised $50 million from Sequoia at a $2 billion valuation", expected: true, label: 'guest: funding + valuation' },
  { speaker: 0, text: "I think Uber did the same thing back in 2015 when they were at this stage", expected: true, label: 'host: historical event + year' },

  // Should NOT classify as claims (5)
  { speaker: 1, text: "Yeah I think the market opportunity is really exciting", expected: false, label: 'guest: opinion' },
  { speaker: 0, text: "That's really interesting, tell me more about that", expected: false, label: 'host: filler' },
  { speaker: 1, text: "We're going after the enterprise market with a bottoms-up strategy", expected: false, label: 'guest: strategy w/o numbers' },
  { speaker: 0, text: "Right right, so what's next for you guys?", expected: false, label: 'host: question' },
  { speaker: 1, text: "I'm really passionate about solving this problem", expected: false, label: 'guest: emotion' },
];

function makeSegment(speaker: number, text: string): TranscriptSegment {
  return {
    id: randomUUID(),
    text,
    speaker,
    speakerLabel: `Speaker ${speaker}`,
    timestamp: 0,
    duration: text.length / 20, // rough proxy
    isFinal: true,
    confidence: 1,
    createdAt: Date.now(),
  };
}

(async () => {
  console.log(`Running ${TESTS.length} classifier tests…\n`);

  let correct = 0;
  let totalLatency = 0;
  const misclassifications: string[] = [];
  let test1Result: { isClaim: boolean; confidence: number; reason: string } | null = null;

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const segment = makeSegment(t.speaker, t.text);
    const { classification, latencyMs } = await classifySegment(segment, [], {});
    totalLatency += latencyMs;

    const fired = classification.isClaim;
    const ok = fired === t.expected;
    if (ok) correct++;
    else misclassifications.push(
      `[#${i + 1} ${t.label}] expected=${t.expected}, got=${fired}, conf=${classification.confidence.toFixed(2)}, reason="${classification.reason}"`
    );

    const mark = ok ? '✓' : '✗';
    console.log(
      `${mark} #${i + 1} ${t.label} (${latencyMs}ms) → fired=${fired}, conf=${classification.confidence.toFixed(2)} | "${t.text.slice(0, 70)}…"`
    );

    if (i === 0) {
      test1Result = {
        isClaim: classification.isClaim,
        confidence: classification.confidence,
        reason: classification.reason,
      };
    }
  }

  const avgLatency = totalLatency / TESTS.length;
  const accuracy = correct / TESTS.length;

  console.log('\n─── Summary ──────────────────────────');
  console.log(`Accuracy:    ${correct}/${TESTS.length} (${(accuracy * 100).toFixed(0)}%)`);
  console.log(`Avg latency: ${avgLatency.toFixed(0)}ms`);
  if (misclassifications.length > 0) {
    console.log('Misclassifications:');
    misclassifications.forEach((m) => console.log(`  ${m}`));
  }
  console.log('──────────────────────────────────────');

  // Halt-condition checks
  let exitCode = 0;
  if (!test1Result?.isClaim) {
    console.error(
      `\n!!! HALT: Test #1 (Jason self-fact-check) FAILED — classifier said is_claim=${test1Result?.isClaim}, conf=${test1Result?.confidence.toFixed(2)}, reason="${test1Result?.reason}"`
    );
    console.error('    This is the core use case. Product fails without it.');
    exitCode = 2;
  }
  if (avgLatency > 2000) {
    console.error(`\n!!! HALT: avg latency ${avgLatency.toFixed(0)}ms exceeds 2000ms ceiling`);
    exitCode = exitCode || 3;
  }

  process.exit(exitCode);
})().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
