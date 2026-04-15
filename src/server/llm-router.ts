import { appConfig } from '../config/config.js';
import { callOllama } from './ollama.js';
import type { LlmProvider, PersonaId } from '../shared/types.js';

/**
 * Per-persona LLM router.
 *
 * Each persona declares its preferred provider chain. callLLM walks the chain,
 * returning the first successful result. Provider failures (timeout, HTTP error)
 * fall through to the next entry; exhausted chains return an empty string.
 *
 * Model IDs and behavior constraints:
 * - haiku: Anthropic Messages API, claude-haiku-4-5-20251001 (authoritative ID
 *   used in config.ts; spec had a typo). Uses system/user message split.
 * - grok: xAI chat completions, grok-4-1-fast. System/user split.
 * - groq: Groq llama-3.3-70b-versatile. System/user split.
 * - ollama: Delegated to existing callOllama client (handles its own timeouts,
 *   retries, and availability tracking).
 *
 * Timeouts: 10s per provider via AbortController, matching spec §1.
 *
 * Returns {text, provider}. Strict spec was Promise<string> but we return
 * the provider name too so queue.ts can pass it to logReaction for the
 * reactions.log engine column — validation scorecards depend on that field.
 */

const ROUTING: Record<string, LlmProvider[]> = {
  'not-jamie': ['haiku', 'groq', 'ollama'],
  'not-fred': ['haiku', 'groq', 'ollama'],
  'not-taco': ['grok', 'haiku', 'groq', 'ollama'],
  'not-robin': ['grok', 'haiku', 'groq', 'ollama'],
  'not-delinquent': ['grok', 'haiku', 'groq', 'ollama'],
};

const PROVIDER_TIMEOUT_MS = 10_000;
const GROK_TIMEOUT_MS = 13_000; // Grok needs longer tail — retry-once on abort handles the rest

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const GROK_MODEL = 'grok-4-1-fast';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

export interface RouterResult {
  text: string;
  provider: LlmProvider | 'none';
}

export async function callLLM(
  personaId: PersonaId | string,
  systemPrompt: string,
  context: string
): Promise<RouterResult> {
  const chain = ROUTING[personaId] ?? ['haiku', 'groq', 'ollama'];

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const next = chain[i + 1];
    const start = Date.now();
    try {
      const text = await callProvider(provider, systemPrompt, context);
      const ms = Date.now() - start;
      console.log(`[${personaId}] responded via ${provider} in ${ms}ms`);
      return { text, provider };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextLabel = next ?? 'none';
      console.warn(`[${personaId}] ${provider} failed (${msg}), falling to ${nextLabel}`);
    }
  }

  console.error(`[${personaId}] all providers exhausted — returning empty`);
  return { text: '', provider: 'none' };
}

// ───────────────────────────────────────────────────────────────────────────
// Provider implementations
// ───────────────────────────────────────────────────────────────────────────

async function callProvider(
  provider: LlmProvider,
  systemPrompt: string,
  context: string
): Promise<string> {
  switch (provider) {
    case 'haiku':
      return callHaiku(systemPrompt, context);
    case 'grok':
      return callGrok(systemPrompt, context);
    case 'groq':
      return callGroqDirect(systemPrompt, context);
    case 'ollama':
      return callOllama(appConfig.ollamaModelTrolls, systemPrompt, context);
  }
}

async function callHaiku(systemPrompt: string, context: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLOUD_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: systemPrompt + '\n\n' + context }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`haiku HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const data: any = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) throw new Error('haiku empty response');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function callGrok(systemPrompt: string, context: string): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) throw new Error('GROK_API_KEY not set');

  // Grok occasionally times out at 10s on first hit; retry once on abort only.
  // HTTP errors and empty responses do NOT retry — they fall through the chain.
  return callGrokAttempt(apiKey, systemPrompt, context, 0);
}

async function callGrokAttempt(
  apiKey: string,
  systemPrompt: string,
  context: string,
  retryCount: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROK_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        max_tokens: 200,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: context },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`grok HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('grok empty response');
    return text;
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort && retryCount < 1) {
      console.warn(`[grok] Aborted at ${GROK_TIMEOUT_MS}ms — retrying once`);
      return callGrokAttempt(apiKey, systemPrompt, context, retryCount + 1);
    }
    throw err;
  }
}

async function callGroqDirect(systemPrompt: string, context: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 200,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: context },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`groq HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('groq empty response');
    return text;
  } finally {
    clearTimeout(timer);
  }
}
