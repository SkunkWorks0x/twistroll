import { appConfig } from '../config/config.js';

/**
 * Call Anthropic Messages API (Claude).
 * 5-second timeout.
 * Throws on any failure so caller can fall back.
 */
export async function cloudGenerate(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const apiKey = process.env.CLOUD_API_KEY;
  if (!apiKey) throw new Error('CLOUD_API_KEY not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  const body = {
    model: appConfig.cloudModel,
    max_tokens: 150,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userPrompt + '\n\nReact in 1-2 sentences max.' },
    ],
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => 'Unknown error');
      throw new Error(`Cloud API HTTP ${res.status}: ${errBody}`);
    }

    const data = await res.json();

    const contentBlocks: Array<{ type: string; text?: string }> = data.content ?? [];
    const textBlock = contentBlocks.filter(b => b.type === 'text' && b.text?.trim()).pop();
    const text = textBlock?.text?.trim();
    if (!text) throw new Error('Empty response from Cloud API');

    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
