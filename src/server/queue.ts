import type { LlmEngine } from '../shared/types.js';
import { appConfig } from '../config/config.js';
import { callOllama } from './ollama.js';
import { cloudGenerate } from './cloud-llm.js';
import { groqGenerate } from './groq-llm.js';

/**
 * Generate a response using the configured LLM mode.
 * hybrid: cloud → groq → ollama
 * cloud:  cloud only (no fallback)
 * local:  ollama only
 */
export async function generate(
  model: string,
  systemPrompt: string,
  userMessage: string,
  personaId?: string
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
