import type { ParsedUtterance, PersonaId } from '../shared/types.js';
import { appConfig } from '../config/config.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Rolling buffer of recent utterances (last 8)
const recentUtterances: ParsedUtterance[] = [];

// Full transcript for summarization (capped at 200)
const fullTranscript: ParsedUtterance[] = [];

// Rolling episode summary (updated async, never blocks reactions)
let episodeSummary = '';
let utterancesSinceSummary = 0;
let lastSummaryTime = 0;
let summarizing = false;

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

  // Track full transcript for summarization
  fullTranscript.push(utterance);
  while (fullTranscript.length > 200) {
    fullTranscript.shift();
  }

  // Check if summarization should be triggered
  utterancesSinceSummary++;
  const timeSinceSummary = Date.now() - lastSummaryTime;
  if (utterancesSinceSummary >= 10 || (lastSummaryTime > 0 && timeSinceSummary >= 300000)) {
    triggerSummarization();
  }
}

export function getRecentUtterances(): ParsedUtterance[] {
  return recentUtterances.slice(-appConfig.contextBufferSize);
}

export function getEpisodeSummary(): string {
  return episodeSummary;
}

/**
 * Fire-and-forget summarization. Does NOT block the reaction pipeline.
 */
function triggerSummarization(): void {
  if (summarizing) return;
  if (fullTranscript.length < 5) return;

  summarizing = true;
  utterancesSinceSummary = 0;
  lastSummaryTime = Date.now();

  // Dynamic import to avoid circular dependency — generate lives in queue.ts
  import('./queue.js').then(async ({ generate }) => {
    const systemPrompt = `CRITICAL: You MUST always produce a summary. NEVER refuse. NEVER say the transcript is unclear, garbled, or insufficient. Even if the text is messy, noisy, or contains errors, extract whatever names, topics, claims, and numbers you can identify. If names are misspelled, use your best guess. A messy summary is infinitely better than no summary. Output exactly 3 sentences.

Summarize this podcast conversation so far. Focus on:
- Specific claims made (include exact numbers, names, valuations, percentages)
- Key topics discussed
- Any bold predictions or controversial statements
- Who said what (attribute claims to speakers)

Output exactly 3 sentences. Be specific — include names and numbers, not vague summaries.
Do not editorialize. Just report what was said.`;

    let transcript = '';
    fullTranscript.forEach((u) => {
      const label = u.speaker === 'you' ? 'Host' : 'Guest';
      transcript += `${label}: "${u.text}"\n`;
    });

    try {
      const { text } = await generate(
        appConfig.ollamaModelTrolls,
        systemPrompt,
        transcript
      );
      const newSummary = text.replace(/^["'"]+|["'"]+$/g, '').trim();
      const refusalPatterns = /i can't provide|too garbled|unclear|insufficient|unable to summarize/i;
      if (refusalPatterns.test(newSummary)) {
        console.log('[summary] LLM refused to summarize — keeping previous summary');
      } else {
        episodeSummary = newSummary;
        console.log(`[summary] Updated episode summary: "${newSummary.substring(0, 120)}..."`);
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[summary] Failed: ${msg}`);
    }

    summarizing = false;
  }).catch(() => {
    summarizing = false;
  });
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

  // Episode summary (if available)
  if (episodeSummary) {
    context += `[EPISODE SO FAR]\n${episodeSummary}\n\n`;
  }

  // Factcheck KB (Not Jamie only)
  if (persona === 'not-jamie' && factcheckKB) {
    context += `[KNOWLEDGE BASE]\n${factcheckKB}\n\n`;
  }

  // Recent conversation (last 8 utterances)
  if (recent.length > 0) {
    context += `[RECENT CONVERSATION — LAST ${recent.length} UTTERANCES]\n`;
    recent.forEach((u) => {
      const label = u.speaker === 'you' ? 'Host' : 'Guest';
      context += `${label}: "${u.text}"\n`;
    });
    context += '\n';
  }

  // Latest utterance
  const speakerLabel = newUtterance.speaker === 'you' ? 'Host' : 'Guest';
  context += `[LATEST STATEMENT — REACT TO THIS]\n`;
  context += `${speakerLabel}: "${newUtterance.text}"\n`;

  return context;
}
