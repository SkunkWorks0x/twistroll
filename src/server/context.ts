import type { ParsedUtterance, PersonaId } from '../shared/types.js';
import { appConfig } from '../config/config.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Rolling buffer of recent utterances
const recentUtterances: ParsedUtterance[] = [];

// Load factcheck KB
let factcheckKB = '';
const kbPath = resolve(__dirname, 'kb', 'factcheck.md');
if (existsSync(kbPath)) {
  factcheckKB = readFileSync(kbPath, 'utf-8');
}

export function addUtterance(utterance: ParsedUtterance): void {
  recentUtterances.push(utterance);
  // Keep only the last N utterances
  while (recentUtterances.length > appConfig.contextBufferSize + 2) {
    recentUtterances.shift();
  }
}

export function getRecentUtterances(): ParsedUtterance[] {
  return recentUtterances.slice(-appConfig.contextBufferSize);
}

/**
 * Build the full context block for a persona's LLM call.
 */
export function buildContext(
  persona: PersonaId,
  newUtterance: ParsedUtterance
): string {
  const recent = getRecentUtterances();

  let context = '';

  // Factcheck KB (Not Jamie only)
  if (persona === 'not-jamie' && factcheckKB) {
    context += `[KNOWLEDGE BASE]\n${factcheckKB}\n\n`;
  }

  // Recent conversation
  if (recent.length > 0) {
    context += `[RECENT CONVERSATION]\n`;
    recent.forEach((u) => {
      const label = u.speaker === 'you' ? 'Host' : 'Guest';
      context += `${label}: "${u.text}"\n`;
    });
    context += '\n';
  }

  // Latest utterance
  const speakerLabel = newUtterance.speaker === 'you' ? 'Host' : 'Guest';
  context += `[LATEST UTTERANCE — REACT TO THIS]\n`;
  context += `${speakerLabel}: "${newUtterance.text}"\n`;

  return context;
}
