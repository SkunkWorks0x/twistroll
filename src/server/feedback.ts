import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { FeedbackData, PersonaId } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', '..', 'data');
const FEEDBACK_PATH = resolve(DATA_DIR, 'feedback.json');

const MAX_POSITIVE = 20;
const MAX_PATTERNS = 10;

const DEFAULT_FEEDBACK: FeedbackData = {
  'not-jamie': { positive_reactions: [], discovered_patterns: [] },
  'not-delinquent': { positive_reactions: [], discovered_patterns: [] },
  'not-cautious': { positive_reactions: [], discovered_patterns: [] },
  'not-taco': { positive_reactions: [], discovered_patterns: [] },
};

/**
 * Load feedback data from disk. Auto-creates on first run.
 */
export function loadFeedback(): FeedbackData {
  ensureDataDir();
  if (!existsSync(FEEDBACK_PATH)) {
    writeFileSync(FEEDBACK_PATH, JSON.stringify(DEFAULT_FEEDBACK, null, 2));
    return structuredClone(DEFAULT_FEEDBACK);
  }
  try {
    const raw = readFileSync(FEEDBACK_PATH, 'utf-8');
    return JSON.parse(raw) as FeedbackData;
  } catch {
    return structuredClone(DEFAULT_FEEDBACK);
  }
}

/**
 * Add a positive reaction for a persona (thumbs-up).
 * FIFO: oldest drops off when hitting max.
 */
export function addPositiveReaction(persona: PersonaId, text: string): void {
  const data = loadFeedback();
  if (!data[persona]) {
    data[persona] = { positive_reactions: [], discovered_patterns: [] };
  }
  data[persona].positive_reactions.push(text);
  while (data[persona].positive_reactions.length > MAX_POSITIVE) {
    data[persona].positive_reactions.shift();
  }
  saveFeedback(data);
}

/**
 * Add a discovered pattern (unsupervised personas only).
 */
export function addPattern(persona: PersonaId, pattern: string): void {
  const data = loadFeedback();
  if (!data[persona]) {
    data[persona] = { positive_reactions: [], discovered_patterns: [] };
  }
  data[persona].discovered_patterns.push(pattern);
  while (data[persona].discovered_patterns.length > MAX_PATTERNS) {
    data[persona].discovered_patterns.shift();
  }
  saveFeedback(data);
}

function saveFeedback(data: FeedbackData): void {
  ensureDataDir();
  writeFileSync(FEEDBACK_PATH, JSON.stringify(data, null, 2));
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}
