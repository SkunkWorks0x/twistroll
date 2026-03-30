import { appConfig } from '../config/config.js';

interface OllamaResponse {
  message?: {
    content: string;
  };
  error?: string;
}

let ollamaAvailable = false;
let firstCallDone = false;

/**
 * Call Ollama chat completion API.
 * Retries once on failure with 500ms delay.
 * First call gets 30s timeout (model loading). Subsequent calls get 15s.
 */
export async function callOllama(
  model: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const timeout = firstCallDone ? 15000 : 30000;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(`${appConfig.ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage + '\n\nReact in 1-2 sentences max.' },
          ],
          stream: false,
          options: {
            temperature: 0.8,
            num_predict: 150, // Keep responses short
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Ollama HTTP ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as OllamaResponse;

      if (data.error) {
        throw new Error(`Ollama error: ${data.error}`);
      }

      const content = data.message?.content?.trim() || '';
      if (!content) {
        throw new Error('Empty response from Ollama');
      }

      firstCallDone = true;
      ollamaAvailable = true;

      // Trim to max 2 sentences
      return trimToSentences(content, 2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (attempt === 0) {
        console.warn(`[ollama] Attempt 1 failed (${model}): ${msg}. Retrying in 500ms...`);
        await sleep(500);
      } else {
        console.error(`[ollama] Attempt 2 failed (${model}): ${msg}. Giving up.`);
        ollamaAvailable = false;
        throw err;
      }
    }
  }

  throw new Error('Ollama call failed after retries');
}

/**
 * Check if Ollama is reachable
 */
export async function checkOllama(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${appConfig.ollamaBaseUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    ollamaAvailable = res.ok;
    return ollamaAvailable;
  } catch {
    ollamaAvailable = false;
    return false;
  }
}

export function isOllamaAvailable(): boolean {
  return ollamaAvailable;
}

function trimToSentences(text: string, max: number): string {
  // Remove any quotes the LLM wraps its response in
  let cleaned = text.replace(/^["']|["']$/g, '').trim();

  // Split on sentence boundaries
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > max) {
    return sentences.slice(0, max).join(' ').trim();
  }
  return cleaned;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
