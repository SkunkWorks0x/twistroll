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

export type PersonaId = 'not-jamie' | 'not-delinquent' | 'not-cautious' | 'not-taco';

export interface ParsedUtterance {
  speaker: string;
  text: string;
  timestamp: number;  // Unix ms
  id: string;         // Generated utterance ID for tracking
}

export interface TrollReaction {
  type: 'troll_comment';
  persona: PersonaId;
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

export type WSMessage = TrollReaction | StatusMessage;

export interface PersonaConfig {
  id: PersonaId;
  name: string;
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
export type LlmEngine = 'cloud' | 'groq' | 'ollama';

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
