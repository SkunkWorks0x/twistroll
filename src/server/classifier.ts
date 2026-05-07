// Stage 1 of the Sentinel pipeline. One Haiku call per finalized window of
// up to 3 transcript segments. Decides whether the window contains a
// verifiable factual claim and, if so, extracts structured fields (primary
// entity, key numbers, claim type, retrieval kernel) for downstream search.
//
// Why a window instead of single segments: Deepgram fragments a thought
// across two or three segments routinely (endpointing on prosody breaks).
// Evaluating a sliding window avoids splitting one logical claim into two.

import { callLLM } from './llm-router.js';
import type {
  ClaimClassification,
  ClaimType,
  EntityType,
  SessionContext,
  TranscriptSegment,
} from '../shared/types.js';

export type SpeakerMap = Record<number, 'host' | 'guest'>;

const PRIOR_CONTEXT_SIZE = 5;

const ENTITY_TYPES: EntityType[] = ['company', 'person', 'product', 'metric', 'event', 'unknown'];
const CLAIM_TYPES: ClaimType[] = ['financial', 'historical', 'attribution', 'comparative', 'prediction', 'unknown'];

const SYSTEM_PROMPT_TEMPLATE = `You are a factual claim detector for a live podcast interview. You evaluate a window of recent statements and determine whether they contain a verifiable factual claim.

SESSION CONTEXT:
Host: {{hostName}} ({{hostCompany}})
Guest: {{guestName}}, {{guestTitle}} at {{guestCompany}}

PRONOUN RESOLUTION:
- When the guest says "we", "our", "my company" → resolve to {{guestCompany}}
- When the host says "I", "we" → resolve to {{hostName}} / {{hostCompany}}
- Use the resolved entity as primary_entity, not the pronoun

A verifiable factual claim contains one or more of:
- A specific number, percentage, or statistic
- A specific date, year, or timeframe
- A named entity + specific assertion
- A superlative or exclusive claim ("only", "first", "highest", "best")
- A funding amount or valuation
- A competitive comparison with named companies
- A historical event or fact tied to a specific claim

NOT a verifiable claim (do NOT fire):
- Opinions without specific numbers
- Predictions without specific figures
- Questions
- Small talk, greetings, filler
- Pure strategy discussion without factual anchors
- Emotional statements

CRITICAL: Treat host statements with IDENTICAL rigor to guest statements.

If the claim spans multiple statements in the window, combine them into one claim_text and set claim_span_start / claim_span_end to the segment labels (seg1, seg2, seg3) covering the range.

KEY_NUMBERS FORMAT — preserve the unit string verbatim from the source. Downstream retrieval kernels parse units, so:
- Use "$40 million", not "40000000" or "40M"
- Use "200%", not "2.0" or "two hundred percent"
- Use "$2 billion", not "$2,000,000,000"
- Use "2015" for a year, not "2015-01-01"
- Use "Q4", "Series B", "$100M ARR" exactly as spoken

Respond with ONLY this JSON, nothing else:
{
  "is_claim": true/false,
  "claim_text": "the complete claim as one sentence, with pronouns resolved to names",
  "speaker": "host"/"guest",
  "confidence": 0.0-1.0,
  "reason": "under 15 words",
  "primary_entity": "company/person/product name or empty string",
  "entity_type": "company/person/product/metric/event/unknown",
  "key_numbers": ["array", "of", "stat strings with units verbatim"],
  "claim_type": "financial/historical/attribution/comparative/prediction/unknown",
  "searchable_noun": "1-3 word search kernel or empty string",
  "claim_span_start": "seg1/seg2/seg3 - first relevant segment label",
  "claim_span_end": "seg1/seg2/seg3 - last relevant segment label"
}

If is_claim is false: primary_entity and searchable_noun are empty strings, key_numbers is [], entity_type and claim_type are "unknown", and claim_span_start = claim_span_end = the most recent segment label (the last seg in the window).`;

function fillContext(template: string, ctx: SessionContext): string {
  return template
    .replace('{{hostName}}', ctx.hostName || '(unknown)')
    .replace('{{hostCompany}}', ctx.hostCompany || '(unknown)')
    .replace('{{guestName}}', ctx.guestName || '(unknown)')
    .replace('{{guestTitle}}', ctx.guestTitle || '(unknown)')
    .replace('{{guestCompany}}', ctx.guestCompany || '(unknown)')
    .replace('{{hostName}}', ctx.hostName || '(unknown)')
    .replace('{{hostCompany}}', ctx.hostCompany || '(unknown)')
    .replace('{{guestCompany}}', ctx.guestCompany || '(unknown)');
}

export function resolveSpeaker(speaker: number, map: SpeakerMap): 'host' | 'guest' {
  const explicit = map[speaker];
  if (explicit === 'host' || explicit === 'guest') return explicit;
  return speaker === 0 ? 'host' : 'guest';
}

function emptyClassification(
  current: TranscriptSegment,
  fallbackSpeaker: 'host' | 'guest',
  reason: string
): ClaimClassification {
  return {
    isClaim: false,
    claimText: '',
    speaker: fallbackSpeaker,
    confidence: 0,
    reason,
    segmentId: current.id,
    timestamp: current.timestamp,
    primaryEntity: '',
    entityType: 'unknown',
    keyNumbers: [],
    claimType: 'unknown',
    searchableNoun: '',
    claimSpan: { startSegmentId: current.id, endSegmentId: current.id },
  };
}

function labelToSegmentId(label: unknown, window: TranscriptSegment[], fallbackId: string): string {
  if (typeof label !== 'string') return fallbackId;
  const m = label.match(/seg(\d+)/i);
  if (!m) return fallbackId;
  const idx = parseInt(m[1], 10) - 1;
  if (idx < 0 || idx >= window.length) return fallbackId;
  return window[idx].id;
}

export async function classifyWindow(
  window: TranscriptSegment[],
  prior: TranscriptSegment[],
  speakerMap: SpeakerMap,
  sessionContext: SessionContext
): Promise<{ classification: ClaimClassification; latencyMs: number }> {
  if (window.length === 0) {
    throw new Error('classifyWindow requires non-empty window');
  }

  const current = window[window.length - 1];
  const fallbackSpeaker = resolveSpeaker(current.speaker, speakerMap);

  // Build user message with seg1..segN labels (UUIDs are too noisy for the LLM
  // to echo reliably; we map labels back to real IDs after the call).
  let userMsg = '';
  if (sessionContext.hostName || sessionContext.guestName || sessionContext.hostCompany || sessionContext.guestCompany) {
    userMsg += 'Session context:\n';
    userMsg += `Host: ${sessionContext.hostName || '(unknown)'} (${sessionContext.hostCompany || ''})\n`;
    userMsg += `Guest: ${sessionContext.guestName || '(unknown)'}, ${sessionContext.guestTitle || ''} at ${sessionContext.guestCompany || ''}\n\n`;
  }

  if (prior.length > 0) {
    userMsg += 'Recent context (prior exchanges):\n';
    for (const r of prior.slice(-PRIOR_CONTEXT_SIZE)) {
      const role = resolveSpeaker(r.speaker, speakerMap) === 'host' ? 'Host' : 'Guest';
      userMsg += `[Speaker ${r.speaker} - ${role}]: "${r.text}"\n`;
    }
    userMsg += '\n';
  }

  userMsg += 'Current window to evaluate (up to 3 segments):\n';
  for (let i = 0; i < window.length; i++) {
    const seg = window[i];
    const role = resolveSpeaker(seg.speaker, speakerMap) === 'host' ? 'Host' : 'Guest';
    const tail = i === window.length - 1 ? ' (most recent)' : '';
    userMsg += `[seg${i + 1}] [${seg.timestamp.toFixed(1)}s] [Speaker ${seg.speaker} - ${role}]: "${seg.text}"${tail}\n`;
  }

  const systemPrompt = fillContext(SYSTEM_PROMPT_TEMPLATE, sessionContext);

  const start = Date.now();
  let raw = '';
  try {
    const result = await callLLM('classifier', systemPrompt, userMsg);
    raw = result.text;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[classifier] LLM call failed (${latencyMs}ms): ${msg}`);
    return {
      classification: emptyClassification(current, fallbackSpeaker, 'classifier call failed'),
      latencyMs,
    };
  }
  const latencyMs = Date.now() - start;

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
    console.warn(`[classifier] malformed JSON for segment ${current.id}: "${raw.slice(0, 120)}"`);
    return {
      classification: emptyClassification(current, fallbackSpeaker, 'malformed classifier output'),
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

  const primaryEntity = isClaim && typeof parsed.primary_entity === 'string' ? parsed.primary_entity : '';
  const entityType: EntityType = ENTITY_TYPES.includes(parsed.entity_type) ? parsed.entity_type : 'unknown';
  const keyNumbers: string[] = Array.isArray(parsed.key_numbers)
    ? parsed.key_numbers.filter((n: unknown): n is string => typeof n === 'string')
    : [];
  const claimType: ClaimType = CLAIM_TYPES.includes(parsed.claim_type) ? parsed.claim_type : 'unknown';
  const searchableNoun = isClaim && typeof parsed.searchable_noun === 'string' ? parsed.searchable_noun : '';

  const startSegmentId = labelToSegmentId(parsed.claim_span_start, window, current.id);
  const endSegmentId = labelToSegmentId(parsed.claim_span_end, window, current.id);

  return {
    classification: {
      isClaim,
      claimText,
      speaker,
      confidence,
      reason,
      segmentId: current.id,
      timestamp: current.timestamp,
      primaryEntity,
      entityType,
      keyNumbers,
      claimType,
      searchableNoun,
      claimSpan: { startSegmentId, endSegmentId },
    },
    latencyMs,
  };
}
