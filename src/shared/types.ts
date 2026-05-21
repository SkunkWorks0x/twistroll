// ─── OpenOats JSONL Schema (SessionRecord) ───
// Source: OpenOats/Sources/Domain/Utterance.swift + Models/Models.swift
// Only fields we use are typed; the rest are ignored via JSON.parse flexibility.

export interface OpenOatsUtterance {
  speaker: string;           // "you" | "them" | "remote_1" etc.
  text: string;              // Raw transcription (always present)
  refinedText?: string | null; // LLM-cleaned version (nullable, prefer when available)
  timestamp: string;         // ISO 8601 date string (Swift Date encodes as ISO)
  // Fields we ignore: id, suggestions, kbHits, suggestionDecision,
  // surfacedSuggestionText, conversationStateSummary, suggestionID,
  // triggerUtteranceID, suggestionLifecycle, refinementStatus
}

// ─── Internal Types ───

export type PersonaId = 'not-jamie' | 'not-delinquent';
export type AgentId = PersonaId | 'sniper';

export interface ParsedUtterance {
  speaker: string;
  text: string;
  timestamp: number;  // Unix ms
  id: string;         // Generated utterance ID for tracking
}

export interface TrollReaction {
  type: 'troll_comment';
  persona: AgentId;
  text: string;
  timestamp: number;
  utteranceId: string;
}

export interface StatusMessage {
  type: 'status';
  state: 'connected' | 'processing' | 'idle' | 'disconnected' | 'ollama_down';
  session?: string;
  lastReaction?: number;
  classifierHealth?: 'live' | 'degraded' | 'offline';
}

// ─── Deepgram transcript segment (Sentinel v2 audio pipeline) ───
export interface TranscriptSegment {
  id: string;
  text: string;
  speaker: number;       // Deepgram diarization speaker index (0, 1, 2…)
  speakerLabel: string;  // Producer-renameable display label, defaults to "Speaker N"
  timestamp: number;     // Seconds from session start
  duration: number;      // Segment duration in seconds
  isFinal: boolean;      // Always true — interim results are dropped before emit
  confidence: number;    // Deepgram per-segment confidence (0–1)
  createdAt: number;     // Date.now() — monotonic ordering for clients
  // Speaker registry resolution (optional — unset until the registry binds a name).
  speakerName?: string;
  speakerRole?: 'host' | 'guest';
}

export interface TranscriptSegmentMessage {
  type: 'transcript_segment';
  data: TranscriptSegment;
}

// ─── Claim classifier (Sentinel two-stage pipeline, Stage 1) ───
export type EntityType = 'company' | 'person' | 'product' | 'metric' | 'event' | 'unknown';
export type ClaimType = 'financial' | 'historical' | 'attribution' | 'comparative' | 'prediction' | 'unknown';

export interface ClaimClassification {
  isClaim: boolean;
  claimText: string;       // empty when isClaim=false
  speaker: 'host' | 'cohost' | 'guest';
  speakerNumber: number;   // raw Deepgram diarization id of the segment that triggered this claim
  confidence: number;      // 0–1
  reason: string;          // brief explanation, ≤15 words
  segmentId: string;       // current segment id (latest in window)
  timestamp: number;       // mirrors TranscriptSegment.timestamp (seconds from session start)

  // Structured extraction (empty defaults when isClaim=false)
  primaryEntity: string;       // resolved from pronouns via SessionContext when applicable
  entityType: EntityType;
  keyNumbers: string[];        // ["200%", "$100M ARR", "Q4"]
  claimType: ClaimType;
  searchableNoun: string;      // 1–3 word retrieval kernel

  // Window span — segment IDs covered by this claim.
  claimSpan: {
    startSegmentId: string;
    endSegmentId: string;
  };
}

export interface ClaimDetectedMessage {
  type: 'claim_detected';
  data: ClaimClassification;
}

// Intermediate pipeline progress — keeps the dashboard from looking dead
// between a claim landing in the queue and a verdict card arriving. Sent
// at three stages: queue accept (detected), retrieval start (retrieving),
// and synthesis start (analyzing).
export interface ClaimProgressMessage {
  type: 'claim_progress';
  claimId: string;
  stage: 'detected' | 'retrieving' | 'analyzing';
  primaryEntity: string;
  claimText: string;  // first 60 chars
}

// ─── Synthesis layer outputs (shipped on the 'claim_card' broadcast) ───
export interface DocketCitationPayload {
  title: string;
  // null marks LanceDB show-archive citations (no public URL — episode reference)
  url: string | null;
  tier: number;
  // Provenance flag — 'haiku' for citations the model emitted, 'post_processor'
  // for ones the LanceDB injection added. Logged on the server for tuning;
  // the dashboard does not render this field.
  citationSource?: 'haiku' | 'post_processor';
  // ≤150-char excerpt from the matched RetrievedSource — drives tooltip hover.
  snippet?: string;
}
export interface DocketPayload {
  grounding: string;
  verdict: 'TRUE' | 'FALSE' | 'MISLEADING' | 'PARTIAL' | 'UNVERIFIABLE';
  explanation: string;
  citations: DocketCitationPayload[];
}
export interface HostContradictionPayload {
  episodeNumber: number;
  episodeDate: string;
  paraphrase: string;
  followUp: string;
  priorChunkId: string;
}
export interface CardBroadcast {
  type: 'claim_card';
  claimId: string;
  claimText: string;
  speaker: 'host' | 'cohost' | 'guest';
  speakerNumber: number;       // raw Deepgram id — dashboard resolves per-id name
  timestamp: number;
  docket: DocketPayload | null;
  hostContradiction: HostContradictionPayload | null;
  timing: {
    docketMs: number;
    contradictionMs: number;
    totalMs: number;
  };
}

// Periodic snapshot of pipeline counters — feeds the bottom-of-sidebar
// stats bar so producers can see the system is alive even when no card
// has rendered yet.
export interface PipelineStatsMessage {
  type: 'pipeline_stats';
  segments: number;       // transcript segments ingested this session
  claimsHeard: number;    // classifier-emitted positive claims above threshold
  cards: number;          // verdict cards broadcast
  suppressed: number;     // claimsHeard - cards - currently in flight
  uneval: number;         // classifier was called but returned no valid extraction (provider failure / malformed)
}

export type WSMessage =
  | TrollReaction
  | StatusMessage
  | TranscriptSegmentMessage
  | ClaimDetectedMessage
  | ClaimProgressMessage
  | PipelineStatsMessage
  | CardBroadcast;

// Structured pipeline failure surfaced from the server to the dashboard.
// Lets the operator see WHY a stream failed instead of a generic "Session
// failed" — without leaking secrets (no URLs with tokens, no env vars).
export interface SessionError {
  code:
    | 'YOUTUBE_BOT_CHECK'
    | 'YOUTUBE_NOT_LIVE_OR_BLOCKED'
    | 'YOUTUBE_UNAVAILABLE_OR_BLOCKED'
    | 'YOUTUBE_HLS_FORBIDDEN'
    | 'YTDLP_EXIT_NONZERO'
    | 'FFMPEG_EXIT_NONZERO'
    | 'AVFOUNDATION_DEVICE_NOT_FOUND'
    | 'AVFOUNDATION_PERMISSION_DENIED'
    | 'DEEPGRAM_DISCONNECTED'
    | 'UNKNOWN_SESSION_ERROR';
  message: string;
  detail?: string;
  hint?: string;
  retryable: boolean;
  source: 'yt-dlp' | 'ffmpeg' | 'deepgram' | 'server';
}

export interface PersonaConfig {
  id: PersonaId;
  name: string;
  role: string;
  color: string;
  systemPrompt: string;
  model: string;
}

export interface FeedbackData {
  [key: string]: {
    positive_reactions: string[];
    discovered_patterns: string[];
  };
}

export type LlmMode = 'local' | 'cloud' | 'hybrid';
export type LlmEngine = 'cloud' | 'groq' | 'ollama' | 'haiku' | 'grok';
export type LlmProvider = 'haiku' | 'grok' | 'groq' | 'ollama' | 'gemini';

export interface AppConfig {
  ollamaBaseUrl: string;
  // Historical name — actually the classifier-fallback Ollama model.
  ollamaModelTrolls: string;
  port: number;
}
