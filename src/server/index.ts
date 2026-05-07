import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { appConfig } from '../config/config.js';
import { checkOllama, isOllamaAvailable } from './ollama.js';
import { addPositiveReaction, addPattern, loadFeedback } from './feedback.js';
import { setCurrentDossier } from './context.js';
import { commitEpisode } from './episodeMemory.js';
import { loadDossier } from './dossier.js';
import type { TrollReaction, StatusMessage, PersonaId } from '../shared/types.js';

const app = express();
app.use(express.json());

// ─── Express Routes ───

// Config panel (served at /config)
app.get('/config', (_req, res) => {
  res.send(configPanelHTML());
});

// API: Get current state
app.get('/api/status', (_req, res) => {
  res.json({
    ollama: isOllamaAvailable(),
    config: {
      cooldownMs: appConfig.cooldownMs,
    },
  });
});

// API: Commit episode — flip provisional chunks to committed
app.post('/api/commit-episode', async (req, res) => {
  const { sessionFile } = req.body as { sessionFile: string };
  if (!sessionFile) return res.status(400).json({ error: 'sessionFile required' });
  try {
    const count = await commitEpisode(sessionFile);
    res.json({ success: true, count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[commit-episode] Failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// API: Load guest dossier
app.post('/api/dossier/load', (req, res) => {
  const { guestName } = req.body as { guestName: string };
  if (!guestName || typeof guestName !== 'string') {
    return res.status(400).json({ error: 'guestName required' });
  }
  const dossier = loadDossier(guestName);
  if (!dossier) {
    return res.status(404).json({ error: `No dossier found for "${guestName}"` });
  }
  setCurrentDossier(dossier);
  console.log(`[dossier] Loaded dossier for "${dossier.name}"`);
  res.json(dossier);
});

// API: Thumbs-up reaction
app.post('/api/feedback/positive', (req, res) => {
  const { persona, text } = req.body as { persona: PersonaId; text: string };
  addPositiveReaction(persona, text);
  res.json({ ok: true });
});

// API: Add pattern
app.post('/api/feedback/pattern', (req, res) => {
  const { persona, pattern } = req.body as { persona: PersonaId; pattern: string };
  addPattern(persona, pattern);
  res.json({ ok: true });
});

// API: Get feedback data
app.get('/api/feedback', (_req, res) => {
  res.json(loadFeedback());
});

// ─── WebSocket Server ───

const server = createServer(app);
const wss = new WebSocketServer({ port: appConfig.wsPort });

const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[ws] Client connected (${clients.size} total)`);

  // Send initial status
  const status: StatusMessage = {
    type: 'status',
    state: isOllamaAvailable() ? 'connected' : 'ollama_down',
  };
  ws.send(JSON.stringify(status));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] Client disconnected (${clients.size} total)`);
  });
});

function broadcast(message: TrollReaction | StatusMessage): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

async function main() {
  // Check Ollama on startup
  const ollamaOk = await checkOllama();
  if (!ollamaOk) {
    console.warn('⚠️  Ollama not detected at', appConfig.ollamaBaseUrl);
    console.warn('   Start Ollama and pull the model: ollama pull qwen2.5:7b');
    console.warn('   Sentinel will retry when utterances arrive.');
  } else {
    console.log('✅ Ollama connected');
  }

  // Start Express server
  server.listen(appConfig.overlayPort, () => {
    console.log('');
    console.log('🔴 TWiST Sentinel is running');
    console.log(`   Config:    http://localhost:${appConfig.overlayPort}/config`);
    console.log(`   WebSocket: ws://localhost:${appConfig.wsPort}`);
    console.log('');
  });

  // Periodic Ollama health check
  setInterval(async () => {
    const wasAvailable = isOllamaAvailable();
    await checkOllama();
    if (!wasAvailable && isOllamaAvailable()) {
      console.log('✅ Ollama reconnected');
      broadcast({ type: 'status', state: 'connected' });
    } else if (wasAvailable && !isOllamaAvailable()) {
      console.warn('⚠️  Ollama disconnected');
      broadcast({ type: 'status', state: 'ollama_down' });
    }
  }, 10000);
}

// ─── Config Panel HTML ───

function configPanelHTML(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sentinel Config</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #1a1a1e; color: #e8e8e8; padding: 24px; }
  h1 { font-size: 20px; color: #FF4D00; margin-bottom: 20px; }
  .card { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .card h2 { font-size: 14px; margin-bottom: 10px; opacity: 0.7; }
  label { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 14px; cursor: pointer; }
  input[type=checkbox] { accent-color: #FF4D00; }
  input[type=range] { width: 200px; }
  button { background: #FF4D00; color: white; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
  button:hover { background: #e64400; }
  .status { font-size: 12px; color: #84CC16; }
  .status.down { color: #ef4444; }
</style></head><body>
<h1>Sentinel Config</h1>
<div class="card">
  <h2>Connection</h2>
  <div id="ollama-status" class="status">Checking Ollama...</div>
</div>
<script>
  // Status polling
  setInterval(async()=>{
    try{
      const r=await fetch('/api/status');
      const d=await r.json();
      const el=document.getElementById('ollama-status');
      el.textContent=d.ollama?'Ollama connected':'Ollama not detected';
      el.className=d.ollama?'status':'status down';
    }catch{}
  },3000);
</script></body></html>`;
}

main().catch(console.error);
