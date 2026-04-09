import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PersonaId } from '../shared/types.js';
import type { PersonaReaction } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REACTIONS_PATH = resolve(__dirname, '..', '..', 'data', 'reactions.log');

/**
 * Format written by logger.ts:
 *   ISO timestamp | persona | [engine] | "reaction text" | utterance: "trigger text"
 */
// Greedy match — reaction text may contain embedded quotes, so anchor on the
// fixed trailing ` | utterance: "..."` structure and let the reaction field
// absorb anything in between.
const LINE_RE =
  /^(\S+)\s+\|\s+(\S+)\s+\|\s+\[(\S+)\]\s+\|\s+"(.*)"\s+\|\s+utterance:\s+"(.*)"\s*$/;

export function parseReactionLine(line: string): PersonaReaction | null {
  const m = line.match(LINE_RE);
  if (!m) return null;
  const [, iso, persona, engine, text, triggerText] = m;
  const timestamp = Date.parse(iso);
  if (isNaN(timestamp)) return null;
  return {
    timestamp,
    persona: persona as PersonaId,
    text,
    triggerText,
    engine,
  };
}

export function readAllReactions(): PersonaReaction[] {
  if (!existsSync(REACTIONS_PATH)) return [];
  const raw = readFileSync(REACTIONS_PATH, 'utf-8');
  const out: PersonaReaction[] = [];
  for (const line of raw.split('\n')) {
    const parsed = parseReactionLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Watch reactions.log for new lines via simple polling. Calls onReaction for each
 * new line parsed. Polling is dead-simple and avoids chokidar/FSEvents flakiness
 * on macOS for append-only log files.
 */
export function watchReactions(onReaction: (r: PersonaReaction) => void): void {
  let offset = 0;
  if (existsSync(REACTIONS_PATH)) {
    offset = statSync(REACTIONS_PATH).size;
  }

  const readNew = () => {
    if (!existsSync(REACTIONS_PATH)) return;
    let size: number;
    try {
      size = statSync(REACTIONS_PATH).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0;
    if (size === offset) return;

    // Read as Buffer and slice by BYTE index. String slicing would break on
    // any multi-byte UTF-8 character (em-dash, curly quotes, etc.) because
    // statSync returns bytes but string.slice uses character indices.
    const full = readFileSync(REACTIONS_PATH);
    const newBuf = full.subarray(offset, size);

    // Only consume up to the last newline byte; trailing partial lines wait.
    const NL = 0x0a;
    let lastNl = -1;
    for (let i = newBuf.length - 1; i >= 0; i--) {
      if (newBuf[i] === NL) { lastNl = i; break; }
    }
    if (lastNl === -1) return;

    const complete = newBuf.subarray(0, lastNl).toString('utf-8');
    offset += lastNl + 1;

    for (const line of complete.split('\n')) {
      const parsed = parseReactionLine(line);
      if (parsed) onReaction(parsed);
    }
  };

  setInterval(readNew, 500);
}
