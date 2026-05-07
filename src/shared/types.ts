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
}

export interface TranscriptSegmentMessage {
  type: 'transcript_segment';
  data: TranscriptSegment;
}

export type WSMessage =
  | TrollReaction
  | StatusMessage
  | TranscriptSegmentMessage;

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
export type LlmProvider = 'haiku' | 'grok' | 'groq' | 'ollama';

export interface AppConfig {
  transcriptDir: string;
  ollamaBaseUrl: string;
  ollamaModelFactchecker: string;
  ollamaModelTrolls: string;
  wsPort: number;
  overlayPort: number;
  cooldownMs: number;
  contextBufferSize: number;
  llmMode: LlmMode;
  cloudModel: string;
  groqModel: string;
}
