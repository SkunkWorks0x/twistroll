// Stage 1 of the Sentinel pipeline. One Haiku call per finalized transcript
// segment. Decides whether the statement contains a verifiable factual claim.
// Target latency <1s — a 70-char tight system prompt and an 8-segment context
// window keep the call cheap.

import { callLLM } from './llm-router.js';
import type { ClaimClassification, TranscriptSegment } from '../shared/types.js';

export type SpeakerMap = Record<number, 'host' | 'guest'>;

const CONTEXT_WINDOW = 8;

const SYSTEM_PROMPT = `You are a factual claim detector for a live podcast interview. Your ONLY job is to determine whether the current statement contains a verifiable factual claim.

A verifiable factual claim contains one or more of:
- A specific number, percentage, or statistic ("we're growing 200% YoY", "92% retention")
- A specific date, year, or timeframe ("we launched in 2024", "three months ago")
- A named entity + specific assertion ("Sequoia led our Series B", "she works at The New Yorker")
- A superlative or exclusive claim ("we're the only company", "highest in the category", "first to market")
- A funding amount or valuation ("raised $50M", "$2B valuation")
- A competitive comparison with named companies ("faster than Stripe", "more users than Slack")
- A historical event or fact tied to a specific claim ("Uber did the same thing in 2015")

NOT a verifiable claim (do NOT fire):
- Opinions without specific numbers ("I think the market is huge")
- Predictions without specific figures ("AI will change everything")
- Questions from the host
- Small talk, greetings, filler ("yeah totally", "that's interesting", "right right")
- Pure strategy discussion without factual anchors ("we're going after enterprise")
- Emotional statements ("I'm really excited about this")

CRITICAL: Treat host statements with IDENTICAL rigor to guest statements. The host wants to fact-check himself.

Respond with ONLY this JSON, nothing else:
{"is_claim": true/false, "claim_text": "extracted claim as a single sentence", "speaker": "host"/"guest", "confidence": 0.0-1.0, "reason": "under 15 words explaining why"}

If is_claim is false, claim_text should be empty string and confidence should be 0.`;

export function resolveSpeaker(speaker: number, map: SpeakerMap): 'host' | 'guest' {
  const explicit = map[speaker];
  if (explicit === 'host' || explicit === 'guest') return explicit;
  return speaker === 0 ? 'host' : 'guest';
}

export async function classifySegment(
  segment: TranscriptSegment,
  recent: TranscriptSegment[],
  speakerMap: SpeakerMap = {}
): Promise<{ classification: ClaimClassification; latencyMs: number }> {
  const fallbackSpeaker = resolveSpeaker(segment.speaker, speakerMap);
  const recentSlice = recent.slice(-CONTEXT_WINDOW);

  let userMsg = 'Recent context (last few exchanges):\n';
  for (const r of recentSlice) {
    const role = resolveSpeaker(r.speaker, speakerMap) === 'host' ? 'Host' : 'Guest';
    userMsg += `${role}: "${r.text}"\n`;
  }
  const currentRole = fallbackSpeaker === 'host' ? 'Host' : 'Guest';
  userMsg += `\nCurrent statement to evaluate:\n${currentRole}: "${segment.text}"\n`;

  const start = Date.now();
  let raw = '';
  try {
    const result = await callLLM('classifier', SYSTEM_PROMPT, userMsg);
    raw = result.text;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[classifier] LLM call failed (${latencyMs}ms): ${msg}`);
    return {
      classification: {
        isClaim: false,
        claimText: '',
        speaker: fallbackSpeaker,
        confidence: 0,
        reason: 'classifier call failed',
        segmentId: segment.id,
        timestamp: segment.timestamp,
      },
      latencyMs,
    };
  }
  const latencyMs = Date.now() - start;

  // Some models occasionally wrap JSON in markdown fences. Strip before parse.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: any = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object') {
    console.warn(`[classifier] malformed JSON for segment ${segment.id}: "${raw.slice(0, 120)}"`);
    return {
      classification: {
        isClaim: false,
        claimText: '',
        speaker: fallbackSpeaker,
        confidence: 0,
        reason: 'malformed classifier output',
        segmentId: segment.id,
        timestamp: segment.timestamp,
      },
      latencyMs,
    };
  }

  const isClaim = parsed.is_claim === true;
  const speaker: 'host' | 'guest' =
    parsed.speaker === 'host' || parsed.speaker === 'guest' ? parsed.speaker : fallbackSpeaker;
  const confidence =
    typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0;
  const claimText = isClaim && typeof parsed.claim_text === 'string' ? parsed.claim_text : '';
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

  return {
    classification: {
      isClaim,
      claimText,
      speaker,
      confidence,
      reason,
      segmentId: segment.id,
      timestamp: segment.timestamp,
    },
    latencyMs,
  };
}
