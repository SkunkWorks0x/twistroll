import chokidar from 'chokidar';
import { createReadStream, statSync, accessSync, constants, readdirSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { appConfig } from '../config/config.js';
import { parseUtterance } from './parser.js';
import type { ParsedUtterance } from '../shared/types.js';

type UtteranceCallback = (utterance: ParsedUtterance) => void;

// Track byte offset per file to avoid re-processing
const filePositions = new Map<string, number>();
let currentSessionFile: string | null = null;

/**
 * Find the most recently modified .jsonl file in dir or its subdirectories.
 * OpenOats creates session subfolders like session_2026-03-29_14-20-27/
 * containing transcript.live.jsonl.
 */
function findNewestJsonl(dir: string): string | null {
  try {
    const results: { path: string; mtime: number }[] = [];

    // Check top-level .jsonl files
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const p = join(dir, entry.name);
        results.push({ path: p, mtime: statSync(p).mtimeMs });
      }
      // Check one level of subdirectories (session folders)
      if (entry.isDirectory()) {
        try {
          for (const sub of readdirSync(join(dir, entry.name))) {
            if (sub.endsWith('.jsonl')) {
              const p = join(dir, entry.name, sub);
              results.push({ path: p, mtime: statSync(p).mtimeMs });
            }
          }
        } catch { /* unreadable subdir */ }
      }
    }

    results.sort((a, b) => b.mtime - a.mtime);
    return results.length > 0 ? results[0].path : null;
  } catch {
    return null;
  }
}

/**
 * Read new lines from a file starting at the last known position
 */
async function readNewLines(
  filePath: string,
  onUtterance: UtteranceCallback
): Promise<void> {
  let startPos = filePositions.get(filePath) || 0;
  const fileName = filePath.split('/').pop();

  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return;
  }

  // Detect file truncation (e.g. simulate script resets with `>`)
  if (fileSize < startPos) {
    console.log(`[watcher] File truncated — resetting offset from ${startPos} to 0 for ${fileName}`);
    startPos = 0;
    filePositions.set(filePath, 0);
  }

  // Nothing new to read
  if (fileSize === startPos) return;

  console.log(`[watcher] Reading new bytes: offset=${startPos} → size=${fileSize} (${fileSize - startPos} bytes) from ${fileName}`);

  return new Promise((resolve) => {
    const stream = createReadStream(filePath, {
      start: startPos,
      encoding: 'utf-8',
    });

    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let bytesRead = startPos;
    let lineCount = 0;
    let parsedCount = 0;

    rl.on('line', (line) => {
      bytesRead += Buffer.byteLength(line, 'utf-8') + 1;
      lineCount++;

      const utterance = parseUtterance(line);
      if (utterance) {
        parsedCount++;
        console.log(`[watcher] Parsed utterance ${utterance.id}: [${utterance.speaker}] "${utterance.text.slice(0, 60)}..."`);
        onUtterance(utterance);
      }
    });

    rl.on('close', () => {
      console.log(`[watcher] Finished reading: ${lineCount} lines, ${parsedCount} parsed, offset now ${bytesRead}`);
      filePositions.set(filePath, bytesRead);
      resolve();
    });

    rl.on('error', () => {
      resolve();
    });
  });
}

/**
 * Start watching the OpenOats transcript directory.
 * Returns the current session filename for status display.
 */
export function startWatcher(onUtterance: UtteranceCallback): {
  getCurrentSession: () => string | null;
} {
  const dir = appConfig.transcriptDir;

  // Validate directory access
  try {
    accessSync(dir, constants.R_OK);
  } catch {
    console.error(`[watcher] Cannot access transcript directory: ${dir}`);
    console.error(`[watcher] Make sure OpenOats is configured to save to this path.`);
    console.error(`[watcher] Check OpenOats Settings → Meeting Notes folder.`);
    return { getCurrentSession: () => null };
  }

  console.log(`[watcher] Watching ${dir} for JSONL changes`);

  // Check for existing files on startup
  const existing = findNewestJsonl(dir);
  if (existing) {
    currentSessionFile = existing;
    console.log(`[watcher] Found existing session: ${existing.split('/').pop()}`);
    // Set position to end of file — don't process old content
    try {
      filePositions.set(existing, statSync(existing).size);
    } catch { /* ignore */ }
  }

  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 2, // session subfolders: sessions/session_YYYY-MM-DD_HH-MM-SS/*.jsonl
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on('change', async (filePath) => {
    if (!filePath.endsWith('.jsonl')) return;

    // Always prefer the most recently modified file
    const newest = findNewestJsonl(dir);
    if (!newest) return;

    // Detect file rotation (new session)
    if (newest !== currentSessionFile) {
      console.log(`[watcher] New session detected: ${newest.split('/').pop()}`);
      currentSessionFile = newest;
      filePositions.delete(newest); // Start from beginning of new file
    }

    // Only read from the current session file
    if (filePath === currentSessionFile || newest === filePath) {
      await readNewLines(filePath, onUtterance);
    }
  });

  watcher.on('add', async (filePath) => {
    if (!filePath.endsWith('.jsonl')) return;

    console.log(`[watcher] New file detected: ${filePath.split('/').pop()}`);
    currentSessionFile = filePath;
    filePositions.delete(filePath);
    await readNewLines(filePath, onUtterance);
  });

  watcher.on('error', (err) => {
    console.error(`[watcher] Error:`, err.message);
  });

  return {
    // Show session folder name (e.g. "session_2026-03-29_14-20-27") or filename
    getCurrentSession: () => {
      if (!currentSessionFile) return null;
      const parts = currentSessionFile.split('/');
      // If file is in a session subfolder, show the folder name
      return parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
    },
  };
}
