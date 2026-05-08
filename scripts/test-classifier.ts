// Smoke test for the windowed claim classifier (v2). Each case is presented
// as a 3-segment window: two neutral priors plus the target statement (or for
// the multi-segment case, a real continuation across segments).
//
// Gates:
//   - All original 10 cases must pass (regression guard)
//   - Test #1 (Jason self-fact-check) must pass — core use case
//   - Test #11 must fire ONCE with claimSpan covering both target segments
//   - Test #12 must resolve the pronoun "we" to "Sabi" via sessionContext
//   - Avg latency must stay under 2000ms
//
// Usage:
//   npx tsx scripts/test-classifier.ts

import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import { classifyWindow } from '../src/server/classifier.js';
import type { ClaimClassification, SessionContext, TranscriptSegment } from '../src/shared/types.js';

loadEnv();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set in .env — classifier needs the Haiku path.');
  process.exit(1);
}

interface Expectations {
  isClaim: boolean;
  // case-insensitive substring; if array, ANY match passes (used when multiple
  // entities in the claim are equally valid as primary — e.g., person OR org).
  primaryEntityIncludes?: string | string[];
  keyNumbersInclude?: string[];            // each must appear in some keyNumbers entry
  spanCoversAllTargetSegments?: boolean;   // for multi-segment claims
}

interface TestCase {
  label: string;
  // 3-segment window: speaker + text. The last entry is "current". Two prior
  // entries pad context. For multi-segment claims, multiple entries carry
  // claim content and we expect spanCoversAllTargetSegments.
  window: Array<{ speaker: 0 | 1; text: string }>;
  sessionContext?: SessionContext;
  expected: Expectations;
  // For the multi-segment claim test, mark which window indices (0–2) are
  // expected to be inside the emitted span.
  expectedSpanIndices?: number[];
}

function neutral(speaker: 0 | 1, text: string) {
  return { speaker, text };
}

const TESTS: TestCase[] = [
  // 1. Jason self-fact-check (THE gate). Either the person (Gia) or the org
  // (New Yorker) is a defensible primary_entity for this claim.
  {
    label: 'host: name+org (Jason example)',
    window: [
      neutral(1, "Yeah let's get into it."),
      neutral(0, "Before we start, one quick correction."),
      neutral(0, "I mentioned this podcast, it was the son Piker and Gia, and she works at The New Yorker"),
    ],
    expected: { isClaim: true, primaryEntityIncludes: ['Gia', 'New Yorker'] },
  },
  // 2. Guest growth + ARR
  {
    label: 'guest: 200% YoY + $100M ARR',
    window: [
      neutral(0, "How's the business doing this year?"),
      neutral(1, "Honestly, way better than we expected."),
      neutral(1, "We're growing 200% year over year and expect to hit $100M ARR by Q4"),
    ],
    expected: { isClaim: true, keyNumbersInclude: ['200', '100M'] },
  },
  // 3. Exclusive
  {
    label: 'guest: exclusive claim',
    window: [
      neutral(0, "Who else is doing this?"),
      neutral(1, "That's the thing."),
      neutral(1, "We're the only company doing this in the market"),
    ],
    expected: { isClaim: true },
  },
  // 4. Funding + valuation. Production always passes sessionContext; without
  // it the LLM correctly can't resolve "we" → guestCompany, so we mirror prod
  // here. Either Acme (the resolved actor) or Sequoia (named investor) is a
  // valid primary_entity.
  {
    label: 'guest: funding + valuation',
    window: [
      neutral(0, "And on the funding side?"),
      neutral(1, "Big year for us."),
      neutral(1, "We raised $50 million from Sequoia at a $2 billion valuation"),
    ],
    sessionContext: {
      hostName: 'Jason Calacanis',
      hostCompany: 'TWIST',
      guestName: 'Test Founder',
      guestCompany: 'Acme',
      guestTitle: 'CEO',
    },
    expected: { isClaim: true, keyNumbersInclude: ['50', '2 billion'], primaryEntityIncludes: ['Acme', 'Sequoia'] },
  },
  // 5. Historical event + year
  {
    label: 'host: historical event + year',
    window: [
      neutral(1, "We had to figure out unit economics quickly."),
      neutral(0, "Yeah, classic stage."),
      neutral(0, "I think Uber did the same thing back in 2015 when they were at this stage"),
    ],
    expected: { isClaim: true, primaryEntityIncludes: 'Uber', keyNumbersInclude: ['2015'] },
  },
  // 6. Opinion (no fire)
  {
    label: 'guest: opinion',
    window: [
      neutral(0, "What's your take on the market?"),
      neutral(1, "It's hard to say."),
      neutral(1, "Yeah I think the market opportunity is really exciting"),
    ],
    expected: { isClaim: false },
  },
  // 7. Filler (no fire)
  {
    label: 'host: filler',
    window: [
      neutral(1, "We've been heads-down on the product."),
      neutral(0, "Mhm."),
      neutral(0, "That's really interesting, tell me more about that"),
    ],
    expected: { isClaim: false },
  },
  // 8. Strategy w/o numbers (no fire)
  {
    label: 'guest: strategy w/o numbers',
    window: [
      neutral(0, "Where are you focused right now?"),
      neutral(1, "Top-down hasn't worked for us."),
      neutral(1, "We're going after the enterprise market with a bottoms-up strategy"),
    ],
    expected: { isClaim: false },
  },
  // 9. Question (no fire)
  {
    label: 'host: question',
    window: [
      neutral(1, "We've been thinking about international."),
      neutral(0, "Cool."),
      neutral(0, "Right right, so what's next for you guys?"),
    ],
    expected: { isClaim: false },
  },
  // 10. Emotion (no fire)
  {
    label: 'guest: emotion',
    window: [
      neutral(0, "Why this problem?"),
      neutral(1, "It's deeply personal."),
      neutral(1, "I'm really passionate about solving this problem"),
    ],
    expected: { isClaim: false },
  },
  // 11. NEW: multi-segment claim across seg2 and seg3
  {
    label: 'guest: multi-segment revenue claim',
    window: [
      neutral(0, "Walk me through the revenue trajectory."),
      neutral(1, "We did $40 million in revenue last year"),
      neutral(1, "That's up from $12 million the year before"),
    ],
    expected: {
      isClaim: true,
      keyNumbersInclude: ['40 million', '12 million'],
      spanCoversAllTargetSegments: true,
    },
    expectedSpanIndices: [1, 2],
  },
  // 12. NEW: pronoun resolution via sessionContext
  {
    label: 'guest: pronoun resolution (We → Sabi)',
    window: [
      neutral(0, "Any recent updates to share?"),
      neutral(1, "Big news this month."),
      neutral(1, "We raised our Series B last month"),
    ],
    sessionContext: {
      hostName: 'Jason Calacanis',
      hostCompany: 'TWIST',
      guestName: 'Rahul Chhabra',
      guestCompany: 'Sabi',
      guestTitle: 'CEO',
    },
    expected: { isClaim: true, primaryEntityIncludes: 'Sabi' },
  },
];

function makeSegment(speaker: number, text: string, tStart: number): TranscriptSegment {
  return {
    id: randomUUID(),
    text,
    speaker,
    speakerLabel: `Speaker ${speaker}`,
    timestamp: tStart,
    duration: Math.max(1, text.length / 20),
    isFinal: true,
    confidence: 1,
    createdAt: Date.now(),
  };
}

function checkExpectations(
  c: ClaimClassification,
  exp: Expectations,
  window: TranscriptSegment[],
  expectedSpanIndices?: number[]
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (c.isClaim !== exp.isClaim) {
    problems.push(`isClaim expected=${exp.isClaim} got=${c.isClaim}`);
  }

  if (exp.isClaim && c.isClaim) {
    if (exp.primaryEntityIncludes) {
      const hay = c.primaryEntity.toLowerCase();
      const needles = Array.isArray(exp.primaryEntityIncludes)
        ? exp.primaryEntityIncludes
        : [exp.primaryEntityIncludes];
      const matched = needles.some((n) => hay.includes(n.toLowerCase()));
      if (!matched) {
        problems.push(`primaryEntity should include one of [${needles.join(', ')}], got "${c.primaryEntity}"`);
      }
    }
    if (exp.keyNumbersInclude) {
      const joined = c.keyNumbers.join(' ').toLowerCase();
      for (const needle of exp.keyNumbersInclude) {
        if (!joined.includes(needle.toLowerCase())) {
          problems.push(`keyNumbers should include "${needle}", got [${c.keyNumbers.join(', ')}]`);
        }
      }
    }
    if (exp.spanCoversAllTargetSegments && expectedSpanIndices) {
      const startIdx = window.findIndex((s) => s.id === c.claimSpan.startSegmentId);
      const endIdx = window.findIndex((s) => s.id === c.claimSpan.endSegmentId);
      if (startIdx === -1 || endIdx === -1) {
        problems.push(`claimSpan ids not found in window (start=${c.claimSpan.startSegmentId}, end=${c.claimSpan.endSegmentId})`);
      } else {
        const lo = Math.min(startIdx, endIdx);
        const hi = Math.max(startIdx, endIdx);
        const covered = new Set<number>();
        for (let i = lo; i <= hi; i++) covered.add(i);
        for (const idx of expectedSpanIndices) {
          if (!covered.has(idx)) {
            problems.push(`expected span to cover seg${idx + 1}, span = seg${lo + 1}..seg${hi + 1}`);
          }
        }
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

(async () => {
  console.log(`Running ${TESTS.length} classifier tests…\n`);

  let correct = 0;
  let totalLatency = 0;
  const misclassifications: string[] = [];
  let test1Passed: boolean | null = null;
  const originalRegressions: string[] = [];

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const window: TranscriptSegment[] = t.window.map((w, k) => makeSegment(w.speaker, w.text, k * 3));
    const ctx = t.sessionContext ?? {};
    const { classification, latencyMs } = await classifyWindow(window, [], {}, ctx);
    totalLatency += latencyMs;

    const { ok, problems } = checkExpectations(classification, t.expected, window, t.expectedSpanIndices);
    if (ok) correct++;
    else {
      misclassifications.push(`[#${i + 1} ${t.label}] ${problems.join(' | ')}`);
      if (i < 10) originalRegressions.push(`#${i + 1} (${t.label})`);
    }

    const mark = ok ? '✓' : '✗';
    console.log(
      `${mark} #${i + 1} ${t.label} (${latencyMs}ms) → fired=${classification.isClaim}, conf=${classification.confidence.toFixed(2)}, entity="${classification.primaryEntity}", numbers=[${classification.keyNumbers.join(', ')}], type=${classification.claimType}`
    );

    if (i === 0) test1Passed = ok && classification.isClaim;
  }

  const avgLatency = totalLatency / TESTS.length;
  const accuracy = correct / TESTS.length;

  console.log('\n─── Summary ──────────────────────────');
  console.log(`Accuracy:    ${correct}/${TESTS.length} (${(accuracy * 100).toFixed(0)}%)`);
  console.log(`Avg latency: ${avgLatency.toFixed(0)}ms`);
  if (misclassifications.length > 0) {
    console.log('Failures:');
    misclassifications.forEach((m) => console.log(`  ${m}`));
  }
  console.log('──────────────────────────────────────');

  let exitCode = 0;
  if (originalRegressions.length > 0) {
    console.error(`\n!!! HALT: regression on original 10 cases — ${originalRegressions.join(', ')}`);
    exitCode = 2;
  }
  if (test1Passed === false) {
    console.error('\n!!! HALT: Test #1 (Jason self-fact-check) FAILED — core use case broken');
    exitCode = exitCode || 3;
  }
  if (avgLatency > 2000) {
    console.error(`\n!!! HALT: avg latency ${avgLatency.toFixed(0)}ms exceeds 2000ms ceiling`);
    exitCode = exitCode || 4;
  }

  process.exit(exitCode);
})().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
