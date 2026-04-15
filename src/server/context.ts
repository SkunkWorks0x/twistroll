import type { ParsedUtterance, PersonaId } from '../shared/types.js';
import { appConfig } from '../config/config.js';
import { readFileSync, existsSync, promises as fsp } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Dossier } from './dossier.js';
import { formatDossierBlock } from './dossier.js';
import { initMemory, queryMemory, formatMemoryBlock } from './episodeMemory.js';

// Cross-episode memory state
let currentMemoryBlock = '';
let memoryLastUpdated = 0;
let memoryAvailable = false;

// Init LanceDB once at startup — if it fails, memory is disabled for the session.
initMemory()
  .then(() => {
    memoryAvailable = true;
    console.log('[memory] LanceDB initialized — cross-episode memory active');
  })
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[memory] LanceDB init failed — cross-episode memory DISABLED: ${msg}`);
  });

let currentDossier: Dossier | null = null;

export function setCurrentDossier(d: Dossier | null): void {
  currentDossier = d;
}

export function getCurrentDossier(): Dossier | null {
  return currentDossier;
}

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

// ───── Daily brief (Not Robin) ─────
// Loaded from data/daily_brief.json at startup, refreshed every 60s.
// Exposed via getDailyBriefBlock() so queue.ts can substitute {{DAILY_BRIEF}}
// in Robin's system prompt before calling the LLM.
const DAILY_BRIEF_PATH = resolve(__dirname, '..', '..', 'data', 'daily_brief.json');
const DAILY_BRIEF_FALLBACK = 'No daily brief loaded. Use your training knowledge only.';
let dailyBriefBlock = DAILY_BRIEF_FALLBACK;

interface DailyBrief {
  headlines?: string[];
  updated?: string;
}

async function loadDailyBrief(): Promise<void> {
  try {
    const raw = await fsp.readFile(DAILY_BRIEF_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as DailyBrief;
    const headlines = Array.isArray(parsed.headlines) ? parsed.headlines : [];
    if (headlines.length === 0) {
      dailyBriefBlock = DAILY_BRIEF_FALLBACK;
      return;
    }
    dailyBriefBlock = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
    console.log(`[brief] Loaded ${headlines.length} headlines (updated ${parsed.updated ?? 'unknown'})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[brief] Load failed: ${msg} — using fallback`);
    dailyBriefBlock = DAILY_BRIEF_FALLBACK;
  }
}

// Initial load + 60s refresh (simple setInterval per spec — not chokidar)
loadDailyBrief();
setInterval(() => {
  loadDailyBrief().catch(() => { /* already swallowed inside */ });
}, 60_000);

export function getDailyBriefBlock(): string {
  return dailyBriefBlock;
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
        // Piggyback a cross-episode memory query on the summary refresh.
        refreshMemoryBlock(newSummary).catch(() => { /* already swallowed */ });
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
 * Fire-and-forget cross-episode memory query. Runs on the summary cadence,
 * never on the per-utterance hot path. Failures are swallowed.
 */
async function refreshMemoryBlock(summary: string): Promise<void> {
  if (!memoryAvailable) return;
  const start = Date.now();
  try {
    const last2 = recentUtterances.slice(-2).map((u) => u.text).join(' ');
    const queryStr = `${summary} ${last2}`.trim();
    if (!queryStr) return;

    const filter = currentDossier ? { guestName: currentDossier.name } : undefined;
    const results = await queryMemory(queryStr, 5, filter);
    const latencyMs = Date.now() - start;

    // Empirically tuned: tech podcast embeddings cluster in 0.32-0.54 cosine range.
    // 0.46 captures meaningful matches without injecting noise.
    const STRONG_MATCH_THRESHOLD = 0.46;
    const strongResults = results.filter((r) => r.score > STRONG_MATCH_THRESHOLD);
    currentMemoryBlock = strongResults.length > 0 ? formatMemoryBlock(strongResults) : '';
    memoryLastUpdated = Date.now();
    console.log(`[memory] Query fired (${latencyMs}ms, ${results.length} results${filter ? `, filter guestName=${filter.guestName}` : ''})`);
    console.log(`[memory] Filtered ${results.length} results to ${strongResults.length} strong matches (>${STRONG_MATCH_THRESHOLD})`);
    if (strongResults.length > 0) {
      console.log(`[memory] Top strong match: [Ep ${strongResults[0].episodeNumber}] score=${strongResults[0].score.toFixed(4)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[memory] Query failed (non-fatal): ${msg}`);
    // Leave previous block in place so one bad query doesn't wipe context.
  }
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

  // Guest dossier (if loaded)
  if (currentDossier) {
    context += `${formatDossierBlock(currentDossier)}\n`;
  }

  // Cross-episode memory (populated on summary cadence, not per utterance)
  if (currentMemoryBlock) {
    context += `${currentMemoryBlock}\n\n`;
  }

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
