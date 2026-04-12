import { appConfig } from '../config/config.js';

/**
 * Call Anthropic Messages API (Claude).
 * 5-second timeout (10s when advisor tool is active to allow escalation RTT).
 * Throws on any failure so caller can fall back.
 */
export async function cloudGenerate(
  systemPrompt: string,
  userPrompt: string,
  personaId?: string
): Promise<string> {
  const apiKey = process.env.CLOUD_API_KEY;
  if (!apiKey) throw new Error('CLOUD_API_KEY not set');

  const useAdvisor =
    personaId === 'not-jamie' &&
    process.env.NOT_JAMIE_ADVISOR_ENABLED === 'true';

  const timeoutMs = useAdvisor ? 30_000 : 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (useAdvisor) {
    headers['anthropic-beta'] = 'advisor-tool-2026-03-01';
  }

  const body: Record<string, unknown> = {
    model: appConfig.cloudModel,
    max_tokens: 150,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userPrompt + '\n\nReact in 1-2 sentences max.' },
    ],
  };
  if (useAdvisor) {
    body.tools = [
      { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-6', max_uses: 1 },
    ];
  }

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
      // If advisor beta header/tool caused the error, retry without it
      if (useAdvisor) {
        console.warn(`[cloud] Advisor request failed (HTTP ${res.status}): ${errBody.slice(0, 120)} — retrying without advisor`);
        return cloudGenerate(systemPrompt, userPrompt);
      }
      throw new Error(`Cloud API HTTP ${res.status}: ${errBody}`);
    }

    const data = await res.json();

    if (useAdvisor) {
      console.log(`[advisor] API response: stop_reason=${data.stop_reason} content_types=${(data.content || []).map((c: any) => c.type).join(',')}`);
    }

    // Log advisor token usage if present
    if (useAdvisor && data.usage) {
      const u = data.usage;
      const advisorIn = u.advisor_input_tokens ?? 0;
      const advisorOut = u.advisor_output_tokens ?? 0;
      if (advisorIn > 0 || advisorOut > 0) {
        console.log(`[advisor] Jamie escalated → advisor tokens: in=${advisorIn} out=${advisorOut} (haiku: in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0})`);
      }
    }

    // Advisor responses have multiple content blocks (server_tool_use, advisor_tool_result, text).
    // Extract the last text block — that's Jamie's final in-character response.
    const contentBlocks: Array<{ type: string; text?: string }> = data.content ?? [];
    const textBlock = contentBlocks.filter(b => b.type === 'text' && b.text?.trim()).pop();
    const text = textBlock?.text?.trim();
    if (!text) throw new Error('Empty response from Cloud API');

    return text;
  } catch (err) {
    clearTimeout(timer);
    // If advisor call threw (network, abort, etc.), retry without advisor
    if (useAdvisor && !(err instanceof Error && err.message.startsWith('Cloud API HTTP'))) {
      console.warn(`[cloud] Advisor call error: ${err instanceof Error ? err.message : err} — retrying without advisor`);
      return cloudGenerate(systemPrompt, userPrompt);
    }
    throw err;
  }
}
