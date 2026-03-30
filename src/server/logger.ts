import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PersonaId, LlmEngine } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const LOG_PATH = resolve(DATA_DIR, 'reactions.log');

/**
 * Append a reaction to the log file.
 * Format: ISO timestamp | persona | "reaction text" | utterance: "trigger text"
 */
export function logReaction(
  persona: PersonaId,
  reactionText: string,
  triggerText: string,
  engine: LlmEngine = 'ollama'
): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const line = `${timestamp} | ${persona} | [${engine}] | "${reactionText}" | utterance: "${triggerText.slice(0, 100)}"\n`;

  try {
    appendFileSync(LOG_PATH, line);
  } catch (err) {
    console.error('[logger] Failed to write reaction log:', err);
  }
}
