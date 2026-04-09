import type { MomentCandidate, VirialityScore, ClipMetadata } from './types.js';

const MODEL = 'claude-haiku-4-5-20251001';
const GEN_TIMEOUT_MS = 8000;

/**
 * Minimal metadata fallback when LLM generation fails.
 */
function minimalMetadata(moment: MomentCandidate, score: VirialityScore): ClipMetadata {
  const snippet = moment.transcript.slice(0, 60).trim();
  return {
    titles: {
      tiktok: snippet || 'TWiST clip',
      youtubeShorts: snippet || 'TWiST clip',
      x: snippet || 'TWiST clip',
    },
    descriptions: {
      short: snippet,
      long: moment.transcript.slice(0, 500),
    },
    hashtags: ['#twist', '#startups', '#podcast'],
    hook: { text: snippet, why: 'fallback' },
    aspectRatio: '9:16',
    thumbnailTimestamp: 0,
    viralityExplanation: score.explanation,
    engagementDrivers: [],
    suggestedCaptions: [],
  };
}

const SYSTEM_PROMPT = `You are a short-form video metadata generator for clips from a live startup podcast (TWiST). You output strictly valid JSON, nothing else.

Given a transcript excerpt and a virality score breakdown, produce platform-optimized metadata. Titles must be punchy and specific. Hashtags must be lowercase, no spaces. aspectRatio defaults to "9:16" for shorts unless the moment is clearly a wide visual.

Respond with exactly this JSON shape, no prose before or after:
{
  "titles": { "tiktok": "...", "youtubeShorts": "...", "x": "..." },
  "descriptions": { "short": "...", "long": "..." },
  "hashtags": ["#tag1", "#tag2", ...],
  "hook": { "text": "...", "why": "..." },
  "aspectRatio": "9:16" | "16:9",
  "thumbnailTimestamp": 0,
  "viralityExplanation": "...",
  "engagementDrivers": ["laugh" | "hot take" | "insight" | "controversy" | ...],
  "suggestedCaptions": ["short caption 1", "short caption 2", ...]
}

Constraints:
- tiktok title: ≤ 70 chars, hook-y
- youtubeShorts title: ≤ 80 chars, SEO-leaning
- x title: ≤ 100 chars, conversational
- descriptions.short: ≤ 150 chars
- descriptions.long: ≤ 500 chars
- 10-15 hashtags
- suggestedCaptions: 3-6 entries, each ≤ 50 chars`;

function buildUserPrompt(moment: MomentCandidate, score: VirialityScore): string {
  return `Transcript window (${moment.reactionsInWindow.length} persona reactions fired in this window):

"""
${moment.transcript.slice(0, 1500)}
"""

Virality score: ${score.total}/100
Breakdown: ${score.explanation}

Persona reactions in the moment:
${moment.reactionsInWindow.map((r) => `- ${r.persona}: "${r.text.slice(0, 120)}"`).join('\n')}

Generate the metadata JSON now.`;
}

/**
 * Extract JSON object from a possibly-noisy LLM response.
 */
function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(raw.slice(start, end + 1));
}

export async function generateMetadata(
  moment: MomentCandidate,
  score: VirialityScore
): Promise<ClipMetadata> {
  const apiKey = process.env.CLOUD_API_KEY;
  if (!apiKey) {
    console.warn('[metadata] CLOUD_API_KEY not set — returning minimal metadata');
    return minimalMetadata(moment, score);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(moment, score) }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Haiku http ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const raw = data.content?.[0]?.text ?? '';
    const parsed = extractJson(raw) as Partial<ClipMetadata>;

    const fallback = minimalMetadata(moment, score);
    return {
      titles: parsed.titles ?? fallback.titles,
      descriptions: parsed.descriptions ?? fallback.descriptions,
      hashtags: parsed.hashtags ?? fallback.hashtags,
      hook: parsed.hook ?? fallback.hook,
      aspectRatio: parsed.aspectRatio === '16:9' ? '16:9' : '9:16',
      thumbnailTimestamp: parsed.thumbnailTimestamp ?? 0,
      viralityExplanation: parsed.viralityExplanation ?? score.explanation,
      engagementDrivers: parsed.engagementDrivers ?? [],
      suggestedCaptions: parsed.suggestedCaptions ?? [],
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[metadata] Generation failed (${msg}) — using minimal metadata`);
    return minimalMetadata(moment, score);
  }
}
