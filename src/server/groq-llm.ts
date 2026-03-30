import { appConfig } from '../config/config.js';

/**
 * Call Groq OpenAI-compatible chat completions API.
 * 5-second timeout. Throws on any failure so caller can fall back.
 */
export async function groqGenerate(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: appConfig.groqModel,
        max_tokens: 150,
        temperature: 0.8,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt + '\n\nReact in 1-2 sentences max.' },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new Error(`Groq API HTTP ${res.status}: ${body}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty response from Groq API');

    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
