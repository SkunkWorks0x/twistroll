import { config } from 'dotenv';
import type { AppConfig } from '../shared/types.js';

config();

export const appConfig: AppConfig = {
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  // Historical name — actually the classifier-fallback model. Consumed by
  // llm-router.ts when both Anthropic and Groq are unavailable.
  ollamaModelTrolls: process.env.OLLAMA_MODEL_TROLLS || 'qwen2.5:7b',
  wsPort: parseInt(process.env.WS_PORT || '3001', 10),
  overlayPort: parseInt(process.env.OVERLAY_PORT || '3000', 10),
};
