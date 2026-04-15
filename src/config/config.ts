import { config } from 'dotenv';
import { resolve } from 'path';
import { homedir } from 'os';
import type { AppConfig, LlmMode } from '../shared/types.js';

config();

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export const appConfig: AppConfig = {
  transcriptDir: expandHome(process.env.OPENOATS_TRANSCRIPT_DIR || '~/Library/Application Support/OpenOats/sessions'),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  ollamaModelFactchecker: process.env.OLLAMA_MODEL_FACTCHECKER || 'qwen2.5:7b',
  ollamaModelTrolls: process.env.OLLAMA_MODEL_TROLLS || 'qwen2.5:7b',
  wsPort: parseInt(process.env.WS_PORT || '3001', 10),
  overlayPort: parseInt(process.env.OVERLAY_PORT || '3000', 10),
  cooldownMs: parseInt(process.env.COOLDOWN_MS || '18000', 10),
  contextBufferSize: parseInt(process.env.CONTEXT_BUFFER_SIZE || '8', 10),
  llmMode: (process.env.LLM_MODE as LlmMode) || 'hybrid',
  cloudModel: process.env.CLOUD_MODEL || 'claude-haiku-4-5-20251001',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
};
