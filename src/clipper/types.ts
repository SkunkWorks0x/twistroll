import type { PersonaId } from '../shared/types.js';

export interface PersonaReaction {
  timestamp: number; // ms since epoch
  persona: PersonaId;
  text: string;
  triggerText: string;
  engine: string;
  thumbsUp?: boolean;
}

export interface MomentCandidate {
  id: string;
  centerTimestamp: number;
  windowStart: number;
  windowEnd: number;
  transcript: string;
  reactionsInWindow: PersonaReaction[];
  episodeNumber?: number;
  sourceVideoPath?: string;
}

export interface VirialityScore {
  total: number;
  signals: {
    personaConsensus: number;
    memoryMatch: number;
    explicitThumbs: number;
    transcriptHeuristics: number;
    manualOverride: number;
  };
  explanation: string;
}

export interface ClipMetadata {
  titles: {
    tiktok: string;
    youtubeShorts: string;
    x: string;
  };
  descriptions: {
    short: string;
    long: string;
  };
  hashtags: string[];
  hook: {
    text: string;
    why: string;
  };
  aspectRatio: '9:16' | '16:9';
  thumbnailTimestamp: number;
  viralityExplanation: string;
  engagementDrivers: string[];
  suggestedCaptions: string[];
}

export type ClipStatus = 'pending' | 'cutting' | 'ready' | 'rejected';

export interface ClipCandidate {
  id: string;
  centerTimestamp: number;
  episodeNumber: number;
  score: number;
  scoreBreakdown: string; // JSON-stringified VirialityScore
  metadata: string; // JSON-stringified ClipMetadata
  status: ClipStatus;
  createdAt: number;
  videoHook: string;
  videoShorts: string;
  videoExtended: string;
  rejectReason: string;
  transcript: string;
  reactionCount: number;
  // vector column required by LanceDB schema
  vector: number[];
}
