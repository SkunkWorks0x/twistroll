import type { ParsedUtterance, PersonaId, TrollReaction, LlmEngine } from '../shared/types.js';
import { appConfig } from '../config/config.js';
import { PERSONAS } from './personas.js';
import { buildContext, addUtterance } from './context.js';
import { callOllama, isOllamaAvailable } from './ollama.js';
import { cloudGenerate } from './cloud-llm.js';
import { groqGenerate } from './groq-llm.js';
import { logReaction } from './logger.js';

type ReactionCallback = (reaction: TrollReaction) => void;

let lastProcessedTime = 0;
let processing = false;
let rotationIndex = 0;

const ROTATION: PersonaId[] = ['not-jamie', 'not-delinquent', 'not-cautious', 'not-taco'];

// Personas that are toggled on (all by default)
const enabledPersonas = new Set<PersonaId>(ROTATION);

/**
 * Generate a response using the configured LLM mode.
 * hybrid: cloud → groq → ollama
 * cloud:  cloud only (no fallback)
 * local:  ollama only
 */
async function generate(
  model: string,
  systemPrompt: string,
  userMessage: string
): Promise<{ text: string; engine: LlmEngine }> {
  const mode = appConfig.llmMode;

  if (mode === 'local') {
    return { text: await callOllama(model, systemPrompt, userMessage), engine: 'ollama' };
  }

  if (mode === 'cloud') {
    return { text: await cloudGenerate(systemPrompt, userMessage), engine: 'cloud' };
  }

  // hybrid: cloud → groq → ollama
  try {
    const text = await cloudGenerate(systemPrompt, userMessage);
    return { text, engine: 'cloud' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[queue] Cloud failed: ${msg} — trying Groq`);
  }

  try {
    const text = await groqGenerate(systemPrompt, userMessage);
    return { text, engine: 'groq' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[queue] Groq failed: ${msg} — falling back to Ollama`);
  }

  return { text: await callOllama(model, systemPrompt, userMessage), engine: 'ollama' };
}

/**
 * Find the next enabled persona in rotation order.
 * Skips disabled personas, wraps around.
 */
function nextPersona(): PersonaId | null {
  for (let i = 0; i < ROTATION.length; i++) {
    const id = ROTATION[rotationIndex % ROTATION.length];
    rotationIndex++;
    if (enabledPersonas.has(id)) return id;
  }
  return null; // all disabled
}

/**
 * Process a new utterance — one persona per utterance, round-robin.
 */
export async function processUtterance(
  utterance: ParsedUtterance,
  onReaction: ReactionCallback
): Promise<void> {
  const now = Date.now();
  const timeSinceLast = now - lastProcessedTime;

  console.log(`[queue] Received utterance ${utterance.id}: cooldown=${timeSinceLast}ms / ${appConfig.cooldownMs}ms, processing=${processing}`);

  // Cooldown gate
  if (timeSinceLast < appConfig.cooldownMs) {
    console.log(`[queue] DROPPED by cooldown gate: ${timeSinceLast}ms < ${appConfig.cooldownMs}ms (${Math.round((appConfig.cooldownMs - timeSinceLast) / 1000)}s remaining)`);
    return;
  }

  // Don't stack processing
  if (processing) {
    console.log(`[queue] DROPPED — already processing another utterance`);
    return;
  }

  // In local/hybrid mode, check Ollama is up (needed as fallback)
  if (appConfig.llmMode !== 'cloud' && !isOllamaAvailable()) {
    console.warn(`[queue] Ollama not available (mode=${appConfig.llmMode}), skipping utterance`);
    return;
  }

  const personaId = nextPersona();
  if (!personaId) {
    console.warn('[queue] All personas disabled, skipping');
    return;
  }

  processing = true;
  lastProcessedTime = now;

  // Add to context buffer
  addUtterance(utterance);

  const persona = PERSONAS[personaId];
  console.log(`[queue] Rotation → ${persona.name}: "${utterance.text.slice(0, 80)}..."`);

  try {
    const context = buildContext(personaId, utterance);

    let { text: response, engine } = await generate(
      persona.model,
      persona.systemPrompt,
      context
    );

    // Strip wrapping quotes
    response = response.replace(/^["'"]+|["'"]+$/g, '');

    // Take first sentence only
    const sentenceMatch = response.match(/^(.*?(?:\.\s|\." |[!?]))/);
    if (sentenceMatch) {
      response = sentenceMatch[1].trimEnd();
    }

    // Hard cap at 220 chars, break at last word boundary
    if (response.length > 220) {
      const truncated = response.slice(0, 220);
      const lastSpace = truncated.lastIndexOf(' ');
      response = (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated.trimEnd()) + '\u2026';
    }

    // Filter flat non-responses from Not Jamie (and any persona)
    const flatResponses = [
      /^that'?s (opinion|vague|prediction)/i,
      /^statement is vague/i,
      /^no verifiable claim/i,
      /^unclear (if|whether)/i,
      /^not enough (context|data|information)/i,
    ];
    if (flatResponses.some((pat) => pat.test(response))) {
      console.log(`[queue] ${persona.name} gave flat response, suppressing: "${response}"`);
      processing = false;
      return;
    }

    const reaction: TrollReaction = {
      type: 'troll_comment',
      persona: personaId,
      text: response,
      timestamp: Date.now(),
      utteranceId: utterance.id,
    };

    onReaction(reaction);
    logReaction(personaId, response, utterance.text, engine);

    console.log(`[queue] ${persona.name} [${engine}]: "${response}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[queue] ${persona.name} failed: ${msg}`);
  }

  processing = false;
}

export function togglePersona(id: PersonaId, enabled: boolean): void {
  if (enabled) {
    enabledPersonas.add(id);
  } else {
    enabledPersonas.delete(id);
  }
}

export function isProcessing(): boolean {
  return processing;
}

export function setCooldown(ms: number): void {
  appConfig.cooldownMs = ms;
}
