import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MomentCandidate } from './types.js';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPS_ROOT = resolve(__dirname, '..', '..', 'data', 'clips');

export interface CutResult {
  hook?: string;
  shorts?: string;
  extended?: string;
}

interface CutJob {
  candidate: MomentCandidate;
  centerSecondsInVideo: number;
  resolve: (r: CutResult) => void;
}

const queue: CutJob[] = [];
let running = false;

/**
 * Enqueue a cut job. Concurrency=1 to keep the MacBook cool.
 * If candidate.sourceVideoPath is missing, returns an empty result without cutting.
 */
export function enqueueCut(candidate: MomentCandidate, centerSecondsInVideo: number): Promise<CutResult> {
  return new Promise((resolveJob) => {
    queue.push({ candidate, centerSecondsInVideo, resolve: resolveJob });
    drain().catch((err) => {
      console.error('[ffmpeg] drain error:', err instanceof Error ? err.message : err);
    });
  });
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      const result = await runCut(job);
      job.resolve(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ffmpeg] Cut failed for ${job.candidate.id}: ${msg}`);
      job.resolve({});
    }
  }
  running = false;
}

async function runCut(job: CutJob): Promise<CutResult> {
  const { candidate, centerSecondsInVideo } = job;

  if (!candidate.sourceVideoPath || !existsSync(candidate.sourceVideoPath)) {
    console.log(
      `[ffmpeg] No source video for ${candidate.id} — skipping cut, metadata-only clip`
    );
    return {};
  }

  const epDir = resolve(CLIPS_ROOT, `episode-${candidate.episodeNumber ?? 'unknown'}`);
  if (!existsSync(epDir)) mkdirSync(epDir, { recursive: true });

  const variants: Array<{ name: 'hook' | 'shorts' | 'extended'; duration: number }> = [
    { name: 'hook', duration: 20 },
    { name: 'shorts', duration: 55 },
    { name: 'extended', duration: 85 },
  ];

  const result: CutResult = {};
  for (const v of variants) {
    const start = Math.max(0, centerSecondsInVideo - v.duration / 2);
    const outFile = resolve(epDir, `clip-${candidate.id}-${v.name}.mp4`);
    const startMs = Date.now();
    try {
      await execFileP('ffmpeg', [
        '-y',
        '-ss', String(start),
        '-i', candidate.sourceVideoPath,
        '-t', String(v.duration),
        '-c', 'copy',
        outFile,
      ]);
      const ms = Date.now() - startMs;
      console.log(`[ffmpeg] Cut clip-${candidate.id}-${v.name}.mp4 in ${ms}ms`);
      result[v.name] = outFile;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ffmpeg] Failed cut ${v.name} for ${candidate.id}: ${msg.slice(0, 160)}`);
    }
  }
  return result;
}
