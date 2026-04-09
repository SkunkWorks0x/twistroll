import chokidar from 'chokidar';
import { createReadStream, statSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { createInterface } from 'readline';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ParsedUtterance } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type UtteranceCallback = (utterance: ParsedUtterance) => void;

export interface ViewerComment {
  timestamp: number;
  username: string;
  text: string;
  platform: 'youtube' | 'x' | 'manual';
}

export const PULSE_FILE = resolve(__dirname, '..', '..', 'data', 'audience-pulse.jsonl');

let fileOffset = 0;
let viewerCount = 0;

function ensurePulseFile(): void {
  const dir = dirname(PULSE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(PULSE_FILE)) writeFileSync(PULSE_FILE, '');
}

export function appendViewerComment(c: Omit<ViewerComment, 'timestamp'> & { timestamp?: number }): ViewerComment {
  ensurePulseFile();
  const full: ViewerComment = {
    timestamp: c.timestamp ?? Date.now(),
    username: c.username,
    text: c.text,
    platform: c.platform,
  };
  appendFileSync(PULSE_FILE, JSON.stringify(full) + '\n');
  return full;
}

function commentToUtterance(c: ViewerComment): ParsedUtterance {
  viewerCount++;
  return {
    id: `viewer_${c.timestamp}_${viewerCount}`,
    speaker: 'viewer',
    text: `[VIEWER @${c.username} on ${c.platform}]: ${c.text}`,
    timestamp: c.timestamp,
  } as ParsedUtterance;
}

async function readNewLines(onUtterance: UtteranceCallback): Promise<void> {
  let size: number;
  try {
    size = statSync(PULSE_FILE).size;
  } catch {
    return;
  }

  if (size < fileOffset) {
    console.log(`[pulse] File truncated — resetting offset from ${fileOffset} to 0`);
    fileOffset = 0;
  }
  if (size === fileOffset) return;

  const start = fileOffset;
  console.log(`[pulse] Reading new bytes: offset=${start} → size=${size} (${size - start} bytes)`);

  await new Promise<void>((resolveP) => {
    const stream = createReadStream(PULSE_FILE, { start, encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let bytes = start;

    rl.on('line', (line) => {
      bytes += Buffer.byteLength(line, 'utf-8') + 1;
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as ViewerComment;
        if (!parsed.username || !parsed.text) return;
        const utt = commentToUtterance(parsed);
        console.log(`[pulse] Viewer comment from @${parsed.username} (${parsed.platform}): "${parsed.text.slice(0, 60)}"`);
        onUtterance(utt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[pulse] Skipping malformed line: ${msg}`);
      }
    });

    rl.on('close', () => {
      fileOffset = bytes;
      resolveP();
    });
    rl.on('error', () => resolveP());
  });
}

/**
 * Start watching the audience-pulse.jsonl file.
 * Runs in parallel with the OpenOats watcher — feeds the same queue.
 */
export function startAudiencePulseWatcher(onUtterance: UtteranceCallback): void {
  ensurePulseFile();

  // Start at end of file so we don't replay history
  try {
    fileOffset = statSync(PULSE_FILE).size;
  } catch {
    fileOffset = 0;
  }

  console.log(`[pulse] Watching ${PULSE_FILE} for viewer comments (starting at offset ${fileOffset})`);

  const watcher = chokidar.watch(PULSE_FILE, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  watcher.on('change', () => {
    readNewLines(onUtterance).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pulse] Read error: ${msg}`);
    });
  });

  watcher.on('add', () => {
    readNewLines(onUtterance).catch(() => {});
  });

  watcher.on('error', (err) => {
    console.error('[pulse] Watcher error:', err instanceof Error ? err.message : err);
  });
}
