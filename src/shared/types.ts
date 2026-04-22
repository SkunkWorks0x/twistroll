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

export type PersonaId = 'not-jamie' | 'not-delinquent' | 'not-taco' | 'not-fred';
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

// ─── Fred sound cue (broadcast to overlay on Fred rotations with sound !== "none") ───
export interface SoundCueMessage {
  type: 'sound_cue';
  sound: string;
}

// ─── Producer controls (config panel → server → overlay) ───
export interface FredAudioToggleMessage {
  type: 'fred_audio_toggle';
  enabled: boolean;
}

export interface FredVolumeMessage {
  type: 'fred_volume';
  volume: number; // capped at 0.3 on both ends
}

export type WSMessage =
  | TrollReaction
  | StatusMessage
  | SoundCueMessage
  | FredAudioToggleMessage
  | FredVolumeMessage;

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
