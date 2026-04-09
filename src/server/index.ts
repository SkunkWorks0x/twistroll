import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { appConfig } from '../config/config.js';
import { startWatcher } from './watcher.js';
import { processUtterance, togglePersona, setCooldown, isProcessing, generate, startSponsorSuppression, recordNotAdFire } from './queue.js';
import { checkOllama, isOllamaAvailable } from './ollama.js';
import { addPositiveReaction, addPattern, loadFeedback } from './feedback.js';
import { checkForSponsor } from './sponsors.js';
import { SNIPER_CONFIG } from './personas.js';
import { getRecentUtterances, setCurrentDossier } from './context.js';
import { loadDossier } from './dossier.js';
import { startAudiencePulseWatcher, appendViewerComment } from './audiencePulse.js';
import {
  loadBrief,
  clearBrief,
  checkBrief,
  generateNotAdOutput,
  getCurrentBrief,
  getLastAlsoMatched,
} from './dailyBrief.js';
import type { TrollReaction, StatusMessage, PersonaId } from '../shared/types.js';
import { logReaction } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ─── Serve Overlay at root ───
app.get('/', (_req, res) => {
  try {
    const overlayPath = resolve(__dirname, '..', 'overlay', 'index.html');
    const html = readFileSync(overlayPath, 'utf-8');
    res.type('html').send(html);
  } catch {
    res.status(404).send('Overlay not found. Check src/overlay/index.html');
  }
});

// ─── Express Routes ───

// Config panel (served at /config)
app.get('/config', (_req, res) => {
  res.send(configPanelHTML());
});

// API: Get current state
app.get('/api/status', (_req, res) => {
  res.json({
    ollama: isOllamaAvailable(),
    processing: isProcessing(),
    session: watcher?.getCurrentSession() || null,
    config: {
      cooldownMs: appConfig.cooldownMs,
    },
  });
});

// API: Toggle persona
app.post('/api/persona/toggle', (req, res) => {
  const { persona, enabled } = req.body as { persona: PersonaId; enabled: boolean };
  togglePersona(persona, enabled);
  res.json({ ok: true });
});

// API: Adjust cooldown
app.post('/api/cooldown', (req, res) => {
  const { ms } = req.body as { ms: number };
  setCooldown(ms);
  res.json({ ok: true, cooldownMs: ms });
});


// API: Toggle sniper
app.post('/api/sniper/toggle', (req, res) => {
  const { enabled } = req.body as { enabled: boolean };
  sniperEnabled = enabled;
  res.json({ ok: true, enabled });
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

// API: Daily brief — load, clear, get current
app.post('/api/brief/load', (req, res) => {
  const brief = req.body;
  if (!brief || !brief.episode || !Array.isArray(brief.ads)) {
    return res.status(400).json({ error: 'Invalid brief format' });
  }
  loadBrief(brief);
  res.json({ status: 'loaded', episode: brief.episode, ads: brief.ads.length });
});

app.post('/api/brief/clear', (_req, res) => {
  clearBrief();
  res.json({ status: 'cleared' });
});

app.get('/api/brief/current', (_req, res) => {
  res.json(getCurrentBrief());
});

// API: Inject a viewer comment (manual / external integrations)
app.post('/api/viewer-comment', (req, res) => {
  const { username, text, platform } = req.body as {
    username?: string;
    text?: string;
    platform?: 'youtube' | 'x' | 'manual';
  };
  if (!username || !text) {
    return res.status(400).json({ error: 'username and text required' });
  }
  const p: 'youtube' | 'x' | 'manual' =
    platform === 'youtube' || platform === 'x' || platform === 'manual' ? platform : 'manual';
  const comment = appendViewerComment({ username, text, platform: p });
  res.json({ ok: true, comment });
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
    session: watcher?.getCurrentSession() || undefined,
  };
  ws.send(JSON.stringify(status));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] Client disconnected (${clients.size} total)`);
  });
});

interface SponsorMessage {
  type: 'sponsor';
  name: string;
  url: string;
  code: string | null;
  copy: string;
  timestamp: number;
}

interface PlugOpportunityMessage {
  type: 'plug-opportunity';
  sponsor: string;
  copy: string;
  url: string;
  code: string | null;
  angle: string;
  matched_trigger: string;
  neutral_pivot: string;
  also_matched: string[];
  timestamp: number;
}

function broadcast(
  message: TrollReaction | StatusMessage | SponsorMessage | PlugOpportunityMessage
): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ─── Watcher Integration ───

let watcher: ReturnType<typeof startWatcher> | null = null;

// ─── Question Sniper ───

let sniperEnabled = false;
let utterancesSinceSniper = 0;
let sniperCount = 0;

async function fireSniper(): Promise<void> {
  if (!sniperEnabled) return;
  if (utterancesSinceSniper < 2) return;

  const recent = getRecentUtterances();
  if (recent.length === 0) return;

  utterancesSinceSniper = 0;
  sniperCount++;

  // Build context from recent utterances
  let context = '[RECENT CONVERSATION]\n';
  recent.forEach((u) => {
    const label = u.speaker === 'you' ? 'Host' : 'Guest';
    context += `${label}: "${u.text}"\n`;
  });
  context += '\n[SUGGEST ONE FOLLOW-UP QUESTION FOR THE HOST]\n';

  try {
    let { text: response, engine } = await generate(
      SNIPER_CONFIG.model,
      SNIPER_CONFIG.systemPrompt,
      context
    );

    // Strip wrapping quotes and question marks
    response = response.replace(/^["'"]+|["'"]+$/g, '');
    response = response.replace(/\?+$/, '');

    // Take first sentence only
    const sentenceMatch = response.match(/^(.*?(?:\.\s|\." |[!?]))/);
    if (sentenceMatch) {
      response = sentenceMatch[1].trimEnd();
      response = response.replace(/\?+$/, '');
    }

    // Hard cap at 120 chars
    if (response.length > 120) {
      const truncated = response.slice(0, 120);
      const lastSpace = truncated.lastIndexOf(' ');
      response = (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated.trimEnd());
    }

    const reaction: TrollReaction = {
      type: 'troll_comment',
      persona: 'sniper',
      text: response,
      timestamp: Date.now(),
      utteranceId: `utt_sniper_${String(sniperCount).padStart(3, '0')}`,
    };

    broadcast(reaction);
    logReaction('sniper' as any, response, recent[recent.length - 1].text, engine);
    console.log(`[sniper] [${engine}]: "${response}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sniper] Failed: ${msg}`);
  }
}

async function main() {
  // Check Ollama on startup
  const ollamaOk = await checkOllama();
  if (!ollamaOk) {
    console.warn('⚠️  Ollama not detected at', appConfig.ollamaBaseUrl);
    console.warn('   Start Ollama and pull the model: ollama pull qwen2.5:7b');
    console.warn('   TWiSTroll will retry when utterances arrive.');
  } else {
    console.log('✅ Ollama connected');
  }

  const handleUtterance = async (utterance: Parameters<Parameters<typeof startWatcher>[0]>[0]) => {
    // Re-check Ollama if it was down
    if (!isOllamaAvailable()) {
      await checkOllama();
    }

    broadcast({
      type: 'status',
      state: 'processing',
      session: watcher?.getCurrentSession() || undefined,
    });

    // Track utterances for sniper gate (show utterances only, not viewer chat)
    if (utterance.speaker !== 'viewer') {
      utterancesSinceSniper++;

      // Sponsor keyword — only runs on show audio, never on viewer chat
      const sponsor = checkForSponsor(utterance.text);
      if (sponsor) {
        broadcast({
          type: 'sponsor',
          name: sponsor.name,
          url: sponsor.url,
          code: sponsor.code || null,
          copy: sponsor.copy,
          timestamp: Date.now(),
        });
        console.log(`[sponsor] ${sponsor.name}: ${sponsor.copy}`);
        startSponsorSuppression();
      }

      // Not Ad — daily-brief contextual ad insertion. Runs in parallel to
      // the sponsor guardian above; both can fire on the same utterance.
      const matchedAd = checkBrief(utterance.text);
      if (matchedAd) {
        const recent = getRecentUtterances().slice(-4);
        const alsoMatched = getLastAlsoMatched();
        generateNotAdOutput(matchedAd, recent, alsoMatched)
          .then((output) => {
            if (!output) return;

            // Mode 1 — viewer overlay: identical render path to the four trolls
            broadcast({
              type: 'troll_comment',
              persona: 'not-ad' as PersonaId,
              text: output.personality_bubble,
              timestamp: Date.now(),
              utteranceId: utterance.id,
            });

            // Mode 2 — producer panel on Launch Bay
            broadcast({
              type: 'plug-opportunity',
              sponsor: output.matched_ad.sponsor,
              copy: output.matched_ad.copy,
              url: output.matched_ad.url,
              code: output.matched_ad.code,
              angle: output.matched_ad.angle,
              matched_trigger: output.matched_trigger,
              neutral_pivot: output.neutral_pivot,
              also_matched: output.also_matched.map((a) => a.sponsor),
              timestamp: Date.now(),
            });

            recordNotAdFire();
            console.log(
              `[not-ad] Fired ${matchedAd.sponsor} on trigger "${output.matched_trigger}"`
            );
          })
          .catch((err) => {
            console.warn(
              `[not-ad] generation error: ${err instanceof Error ? err.message : String(err)}`
            );
          });
      }
    }

    await processUtterance(utterance, (reaction) => {
      broadcast(reaction);
    });

    broadcast({
      type: 'status',
      state: 'idle',
      session: watcher?.getCurrentSession() || undefined,
    });
  };

  // Start file watcher (OpenOats transcripts)
  watcher = startWatcher(handleUtterance);

  // Start audience pulse watcher (viewer comments) — runs in parallel, same queue
  startAudiencePulseWatcher(handleUtterance);

  // Start Express server
  server.listen(appConfig.overlayPort, () => {
    console.log('');
    console.log('🔴 TWiSTroll is running');
    console.log(`   Overlay:  http://localhost:${appConfig.overlayPort}`);
    console.log(`   Config:   http://localhost:${appConfig.overlayPort}/config`);
    console.log(`   WebSocket: ws://localhost:${appConfig.wsPort}`);
    console.log(`   Watching: ${appConfig.transcriptDir}`);
    console.log(`   Sniper:  every 75s (enabled=${sniperEnabled})`);
    console.log('');
  });

  // Question Sniper timer — fires every 75s independently of troll rotation
  setInterval(() => {
    fireSniper().catch((err) => console.error('[sniper] Timer error:', err));
  }, 75000);

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
<html><head><meta charset="utf-8"><title>TWiSTroll Config</title>
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
  #obs-url { font-size: 12px; color: #94A3B8; word-break: break-all; margin-top: 8px; }
</style></head><body>
<h1>TWiSTroll Config</h1>
<div class="card">
  <h2>Connection</h2>
  <div id="ollama-status" class="status">Checking Ollama...</div>
  <div id="session-status" style="font-size:12px;color:#94A3B8;margin-top:4px;"></div>
</div>
<div class="card">
  <h2>Personas</h2>
  <label><input type="checkbox" checked data-persona="not-jamie"> Not Jamie (Fact-checker)</label>
  <label><input type="checkbox" checked data-persona="not-delinquent"> Not Delinquent (Chaotic)</label>
  <label><input type="checkbox" checked data-persona="not-cautious"> Not Cautious (Cynical)</label>
  <label><input type="checkbox" checked data-persona="not-taco"> Not Taco (Comedy)</label>
</div>
<div class="card">
  <h2>Question Sniper</h2>
  <label><input type="checkbox" id="sniper-toggle"> Question Sniper (fires every 75s)</label>
  <div id="sniper-latest" style="font-size:12px;color:#94A3B8;margin-top:8px;font-style:italic;"></div>
</div>
<div class="card">
  <h2>Timing</h2>
  <label>Cooldown: <span id="cd-val">15</span>s <input type="range" min="5" max="60" value="15" id="cooldown"></label>
</div>
<div class="card">
  <h2>OBS Setup</h2>
  <button id="copy-url">Copy OBS URL</button>
  <div id="obs-url">http://localhost:${appConfig.overlayPort}?mode=prod</div>
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
      document.getElementById('session-status').textContent=d.session?'Session: '+d.session:'No active session';
    }catch{}
  },3000);

  // Persona toggles
  document.querySelectorAll('[data-persona]').forEach(cb=>{
    cb.addEventListener('change',async(e)=>{
      const t=e.target;
      await fetch('/api/persona/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({persona:t.dataset.persona,enabled:t.checked})});
    });
  });

  // Cooldown
  document.getElementById('cooldown').addEventListener('input',async(e)=>{
    const v=e.target.value;
    document.getElementById('cd-val').textContent=v;
    await fetch('/api/cooldown',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ms:v*1000})});
  });

  // Sniper toggle
  document.getElementById('sniper-toggle').addEventListener('change',async(e)=>{
    await fetch('/api/sniper/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:e.target.checked})});
  });

  // Copy URL
  document.getElementById('copy-url').addEventListener('click',()=>{
    navigator.clipboard.writeText('http://localhost:${appConfig.overlayPort}?mode=prod');
    document.getElementById('copy-url').textContent='Copied!';
    setTimeout(()=>document.getElementById('copy-url').textContent='Copy OBS URL',2000);
  });
</script></body></html>`;
}

main().catch(console.error);
