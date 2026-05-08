// Smoke test for the DeepgramClient. Streams ~60s of a YouTube clip,
// prints every finalized segment, then exits with a summary.
//
// Usage:
//   npx tsx scripts/test-deepgram.ts [youtube-url]
//   DEEPGRAM_API_KEY must be set in .env (not the placeholder).

import { config as loadEnv } from 'dotenv';
import { DeepgramClient } from '../src/server/deepgram.js';
import type { TranscriptSegment } from '../src/shared/types.js';

loadEnv();

const SESSION_DURATION_MS = 60_000;
const DEFAULT_URL = 'https://youtu.be/RT09WX9_hqY'; // TWiST E2280 Defense Tech — known multi-speaker

const apiKey = process.env.DEEPGRAM_API_KEY?.trim() || '';
if (!apiKey) {
  console.error('ERROR: DEEPGRAM_API_KEY is not set in .env');
  console.error('  1. Sign up / log in at https://deepgram.com');
  console.error('  2. Copy your API key');
  console.error('  3. Add to .env: DEEPGRAM_API_KEY=<your-key>');
  process.exit(1);
}

const url = process.argv[2] || DEFAULT_URL;
console.log(`[test] target URL:  ${url}`);
console.log(`[test] duration:    ${SESSION_DURATION_MS / 1000}s`);
console.log(`[test] api key:     ${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`);
console.log('');

const client = new DeepgramClient(apiKey);

let segmentCount = 0;
const speakers = new Set<number>();
const errors: string[] = [];

client.on('segment', (s: TranscriptSegment) => {
  segmentCount++;
  speakers.add(s.speaker);
  const ts = s.timestamp.toFixed(2).padStart(7);
  console.log(`[${ts}s] [Speaker ${s.speaker}] (conf ${s.confidence.toFixed(2)}) ${s.text}`);
});

client.on('connected', () => console.log('[test] Deepgram connected'));
client.on('disconnected', () => console.log('[test] Deepgram disconnected'));
client.on('reconnecting', ({ attempt }: { attempt: number }) =>
  console.warn(`[test] reconnecting (attempt ${attempt})`)
);
client.on('error', (err: Error) => {
  errors.push(err.message);
  console.error(`[test] error: ${err.message}`);
});

let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n[test] shutting down (${reason})…`);
  try {
    await client.stopSession();
  } catch (err) {
    console.error(`[test] stopSession threw: ${err}`);
  }
  console.log('');
  console.log('─── Summary ──────────────────────────');
  console.log(`segments received: ${segmentCount}`);
  console.log(`unique speakers:   ${speakers.size} (${[...speakers].sort().join(', ') || 'none'})`);
  console.log(`errors:            ${errors.length}`);
  if (errors.length > 0) {
    errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }
  console.log('──────────────────────────────────────');
  process.exit(errors.length > 0 ? 1 : 0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  try {
    await client.startSession({ mode: 'stream', source: url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[test] startSession failed: ${msg}`);
    process.exit(1);
  }

  setTimeout(() => shutdown('duration elapsed'), SESSION_DURATION_MS);
})();
