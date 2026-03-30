import { appConfig } from '../config/config.js';

/**
 * Call Anthropic Messages API (Claude).
 * 5-second timeout. Throws on any failure so caller can fall back.
 */
export async function cloudGenerate(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const apiKey = process.env.CLOUD_API_KEY;
  if (!apiKey) throw new Error('CLOUD_API_KEY not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: appConfig.cloudModel,
        max_tokens: 150,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt + '\n\nReact in 1-2 sentences max.' },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new Error(`Cloud API HTTP ${res.status}: ${body}`);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) throw new Error('Empty response from Cloud API');

    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
