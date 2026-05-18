import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { appConfig } from '../config/config.js';
import { checkOllama, isOllamaAvailable } from './ollama.js';
import { commitEpisode } from './episodeMemory.js';
import { loadDossier, setCurrentDossier } from './dossier.js';
import { DeepgramClient, SessionMode } from './deepgram.js';
import { classifyWindow, SpeakerMap } from './classifier.js';
import { enqueueClaim, queueStats, setProcessHandler } from './claimQueue.js';
import { getBreakerState } from './retrieval.js';
import { synthesize } from './synthesis.js';
import { recordStage, getStages, dropStages } from './ttfcStages.js';
import type {
  TrollReaction,
  StatusMessage,
  TranscriptSegmentMessage,
  ClaimDetectedMessage,
  TranscriptSegment,
  ClaimClassification,
  CardBroadcast,
  SessionError,
} from '../shared/types.js';
import { SessionPipelineError } from './deepgram.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', '..', 'public');

const app = express();
app.use(express.json());

// Serve the producer dashboard (public/index.html) at GET /. Static middleware
// runs before the API routes, so / and any /assets fall through here while
// /api/* and /config still hit their handlers below.
app.use(express.static(PUBLIC_DIR));

// ─── Express Routes ───

// Config panel (served at /config)
app.get('/config', (_req, res) => {
  res.send(configPanelHTML());
});

// Bearer-token gate for all /api/* routes. No-op when AUTH_ENABLED is false.
app.use('/api', (req, res, next) => {
  if (!AUTH_ENABLED) return next();
  const header = req.header('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1] !== ACCESS_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// API: Get current state
app.get('/api/status', (_req, res) => {
  res.json({
    ollama: isOllamaAvailable(),
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

// ─── Deepgram session ───
// Singleton — null if DEEPGRAM_API_KEY missing at boot. Endpoints below
// 503 in that case so the failure mode is visible rather than silent.
const deepgramApiKey = process.env.DEEPGRAM_API_KEY || '';
const deepgram: DeepgramClient | null = deepgramApiKey
  ? new DeepgramClient(deepgramApiKey)
  : null;

// ─── Auth (single shared bearer token) ───
// SENTINEL_ACCESS_TOKEN unset → auth disabled (local dev).
// Set but <24 chars (including empty string) → refuse to start so an
// accidentally-empty Railway env var doesn't silently disable auth.
const rawToken = process.env.SENTINEL_ACCESS_TOKEN;
if (rawToken !== undefined && rawToken.length < 24) {
  throw new Error(
    'SENTINEL_ACCESS_TOKEN is set but shorter than 24 characters — refusing to start. ' +
      'Set a longer token or unset the env var to disable auth.'
  );
}
const ACCESS_TOKEN = rawToken ?? '';
const AUTH_ENABLED = ACCESS_TOKEN.length >= 24;

// When the cloud embedding provider is in use, Ollama isn't reachable and
// isn't load-bearing — don't surface "OLLAMA DOWN" to the dashboard, and
// skip the periodic health-check polling entirely.
const OLLAMA_NEEDED = process.env.EMBED_PROVIDER !== 'openai';

// ─── Session state machine ───
type SessionUiState = 'idle' | 'connecting' | 'live' | 'error';
interface SessionStateMessage {
  type: 'session_state';
  state: SessionUiState;
  url?: string;
  error?: SessionError;
}
let sessionState: SessionUiState = 'idle';
let sessionUrl: string | null = null;
let sessionStartedAt: string | null = null;
let lastSessionError: SessionError | null = null;
// Tracks an in-flight startSession() so /api/session/stop can wait for it
// before deciding the session is gone. Without this, a Stop click during
// 'connecting' can race past a half-spawned ffmpeg and orphan it.
let pendingStart: Promise<void> | null = null;

function setSessionState(next: SessionUiState, url?: string, error?: SessionError): void {
  if (sessionState === next && (next !== 'error' || !error)) return;
  sessionState = next;
  if (next === 'connecting' && url) {
    sessionUrl = url;
    sessionStartedAt = new Date().toISOString();
    lastSessionError = null;
  } else if (next === 'idle') {
    sessionUrl = null;
    sessionStartedAt = null;
    lastSessionError = null;
  } else if (next === 'error' && error) {
    lastSessionError = error;
  }
  console.log(`[session] state=${next}${sessionUrl ? ` url=${sessionUrl}` : ''}${error ? ` code=${error.code}` : ''}`);
  const msg: SessionStateMessage = { type: 'session_state', state: next };
  if (sessionUrl) msg.url = sessionUrl;
  if (next === 'error' && lastSessionError) msg.error = lastSessionError;
  broadcast(msg);
}

function toSessionError(err: unknown, source: SessionError['source'] = 'server'): SessionError {
  if (err instanceof SessionPipelineError) return err.sessionError;
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'UNKNOWN_SESSION_ERROR',
    source,
    message: message || 'Session failed.',
    retryable: true,
  };
}

// ─── Classifier state ───
const SEGMENT_BUFFER_MAX = 12;
const WINDOW_SIZE = 3;
const CLAIM_CONFIDENCE_THRESHOLD = parseFloat(process.env.CLAIM_CONFIDENCE_THRESHOLD || '0.7');
const CLAIM_SPAN_TTL_MS = 15000;
const lastSegments: TranscriptSegment[] = [];

// Bounded Map for TTFC pairing. claimId → utteranceEndMs (epoch ms at
// is_final receipt). Cap at 200 entries; evict oldest on insert when full.
// JS Map preserves insertion order so .keys().next() yields the oldest.
const TTFC_MAP_MAX = 200;
const ttfcUtteranceEndMs = new Map<string, number>();
function recordTtfcAnchor(claimId: string, ms: number): void {
  if (ttfcUtteranceEndMs.size >= TTFC_MAP_MAX) {
    const oldest = ttfcUtteranceEndMs.keys().next().value;
    if (oldest !== undefined) ttfcUtteranceEndMs.delete(oldest);
  }
  ttfcUtteranceEndMs.set(claimId, ms);
}
let currentSpeakerMap: SpeakerMap = {};

interface ActiveSpan {
  coveredIds: Set<string>;
  expiresAt: number;
}
const activeSpans: ActiveSpan[] = [];

const classifierStats = {
  segmentsProcessed: 0,
  segmentsSkippedBySpan: 0,
  claimsDetected: 0,
  claimsByHost: 0,
  claimsByCohost: 0,
  claimsByGuest: 0,
  sumConfidence: 0,
  sumLatencyMs: 0,
};

function pruneExpiredSpans(): void {
  const now = Date.now();
  for (let i = activeSpans.length - 1; i >= 0; i--) {
    if (activeSpans[i].expiresAt <= now) activeSpans.splice(i, 1);
  }
}

function isSegmentInActiveSpan(segId: string): boolean {
  pruneExpiredSpans();
  return activeSpans.some((s) => s.coveredIds.has(segId));
}

function markSpanActive(window: TranscriptSegment[], span: ClaimClassification['claimSpan']): void {
  // Translate the LLM-reported start/end IDs to the set of window IDs they cover.
  const startIdx = window.findIndex((s) => s.id === span.startSegmentId);
  const endIdx = window.findIndex((s) => s.id === span.endSegmentId);
  let covered: string[];
  if (startIdx === -1 || endIdx === -1) {
    // Fallback: only the current segment.
    covered = [window[window.length - 1].id];
  } else {
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    covered = window.slice(lo, hi + 1).map((s) => s.id);
  }
  activeSpans.push({
    coveredIds: new Set(covered),
    expiresAt: Date.now() + CLAIM_SPAN_TTL_MS,
  });
}

if (deepgram) {
  deepgram.on('segment', (segment: TranscriptSegment) => {
    // First segment after startSession → transition from 'connecting' to 'live'.
    if (sessionState === 'connecting') setSessionState('live');

    // Broadcast first — never gate transcript visibility on classifier latency.
    broadcast({ type: 'transcript_segment', data: segment });

    // Roll the context buffer.
    lastSegments.push(segment);
    while (lastSegments.length > SEGMENT_BUFFER_MAX) lastSegments.shift();

    // Dedup: if this segment is already inside an active claimSpan, the prior
    // claim covered it — don't re-classify.
    if (isSegmentInActiveSpan(segment.id)) {
      classifierStats.segmentsSkippedBySpan++;
      console.log(`[CLASSIFIER] Segment ${segment.id} within active claimSpan, skipping`);
      console.log(`[classifier-suppress] reason=span_dedup segmentId=${segment.id}`);
      return;
    }

    // Build the 3-segment evaluation window plus prior context behind it.
    const window = lastSegments.slice(-WINDOW_SIZE);
    const prior = lastSegments.slice(0, -WINDOW_SIZE);

    classifyWindow(window, prior, currentSpeakerMap)
      .then(({ classification, latencyMs }) => {
        const classifierEndMs = Date.now();
        classifierStats.segmentsProcessed++;
        classifierStats.sumLatencyMs += latencyMs;

        if (classification.isClaim && classification.confidence >= CLAIM_CONFIDENCE_THRESHOLD) {
          classifierStats.claimsDetected++;
          classifierStats.sumConfidence += classification.confidence;
          if (classification.speaker === 'host') classifierStats.claimsByHost++;
          else if (classification.speaker === 'cohost') classifierStats.claimsByCohost++;
          else classifierStats.claimsByGuest++;

          markSpanActive(window, classification.claimSpan);
          broadcast({ type: 'claim_detected', data: classification });
          console.log(
            `[CLASSIFIER] Claim detected: "${classification.claimText}" (speaker: ${classification.speaker}, confidence: ${classification.confidence.toFixed(2)})`
          );

          recordStage(classification.segmentId, 'classifierEndMs', classifierEndMs);
          // Enqueue for retrieval. Snapshot of last 12 segments captured inside
          // the queue so processing sees fire-time state.
          enqueueClaim(classification, lastSegments);
        } else if (classification.isClaim) {
          console.log(
            `[CLASSIFIER] Claim below threshold (${classification.confidence.toFixed(2)} < ${CLAIM_CONFIDENCE_THRESHOLD}): "${classification.claimText}"`
          );
          console.log(`[classifier-suppress] reason=low_confidence confidence=${classification.confidence.toFixed(2)} claimText="${classification.claimText.slice(0, 50)}"`);
        } else {
          console.log(`[CLASSIFIER] No claim: "${classification.reason}"`);
          console.log(`[classifier-suppress] reason=not_a_claim segmentId=${segment.id}`);
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[classifier] unhandled error: ${msg}`);
      });
  });
  deepgram.on('error', (err: Error) => {
    console.error(`[deepgram] error event: ${err.message}`);
    // Ignore teardown noise: ws close + ffmpeg SIGTERM during stopSession()
    // fire 'error' after we've already reset to 'idle'. Without this guard
    // the state ends in 'error' instead of 'idle'.
    if (sessionState === 'idle') return;
    setSessionState('error', undefined, toSessionError(err));
  });
  deepgram.on('reconnecting', ({ attempt }: { attempt: number }) => {
    console.warn(`[deepgram] reconnecting (attempt ${attempt})`);
  });
} else {
  console.warn('[deepgram] DEEPGRAM_API_KEY not set — session endpoints will return 503');
}

function validateSpeakerMap(input: unknown): SpeakerMap {
  if (!input || typeof input !== 'object') return {};
  const out: SpeakerMap = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const id = parseInt(k, 10);
    if (!Number.isNaN(id) && (v === 'host' || v === 'cohost' || v === 'guest')) {
      out[id] = v;
    }
  }
  return out;
}

// ─── Synthesis pipeline: claim queue → retrieval → synthesis → broadcast ─
setProcessHandler(async ({ claim, segmentSnapshot, retrieval }) => {
  try {
    const triggerSeg = segmentSnapshot.find((s) => s.id === claim.segmentId);
    const utteranceEndMs = triggerSeg ? triggerSeg.createdAt : Date.now();
    recordTtfcAnchor(claim.segmentId, utteranceEndMs);
    console.log(`[ttfc-server] claimId=${claim.segmentId} utteranceEndMs=${utteranceEndMs}`);
    const result = await synthesize(claim, retrieval.merged, segmentSnapshot);
    recordStage(claim.segmentId, 'synthesisEndMs', Date.now());
    if (!result.docket?.verdict) {
      console.log(`[synthesis] suppressed card — no Docket verdict claimId=${claim.segmentId} primaryEntity="${claim.primaryEntity}"`);
      return;
    }
    const card: CardBroadcast = {
      type: 'claim_card',
      claimId: claim.segmentId,
      claimText: claim.claimText,
      speaker: claim.speaker,
      speakerNumber: claim.speakerNumber,
      timestamp: claim.timestamp,
      docket: result.docket,
      hostContradiction: result.hostContradiction,
      timing: result.timing,
    };
    recordStage(claim.segmentId, 'broadcastSendMs', Date.now());
    broadcast(card);
    const stages = getStages(claim.segmentId);
    const utteranceEnd = ttfcUtteranceEndMs.get(claim.segmentId);
    if (
      stages?.classifierEndMs !== undefined &&
      stages.retrievalStartMs !== undefined &&
      stages.retrievalEndMs !== undefined &&
      stages.synthesisEndMs !== undefined &&
      utteranceEnd !== undefined
    ) {
      const classifierMs = stages.classifierEndMs - utteranceEnd;
      const queueWaitMs = stages.retrievalStartMs - stages.classifierEndMs;
      const retrievalMs = stages.retrievalEndMs - stages.retrievalStartMs;
      const synthesisMs = stages.synthesisEndMs - stages.retrievalEndMs;
      console.log(
        `[ttfc-stages] claimId=${claim.segmentId} classifierMs=${classifierMs} queueWaitMs=${queueWaitMs} retrievalMs=${retrievalMs} synthesisMs=${synthesisMs}`
      );
    }
    console.log(
      `[SYNTHESIS] claim=${claim.segmentId.slice(0, 8)} docket=${result.docket?.verdict ?? 'null'} contradiction=${result.hostContradiction ? 'fired' : 'null'} total=${result.timing.totalMs}ms`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SYNTHESIS] failed: ${msg}`);
  }
});

app.post('/api/session/start', async (req, res) => {
  if (!deepgram) {
    return res.status(503).json({ error: 'DEEPGRAM_API_KEY not configured' });
  }
  const body = req.body as {
    mode?: SessionMode | 'youtube';
    source?: string;
    url?: string;
    speakerMap?: unknown;
    startOffsetSeconds?: unknown;
  };

  // Normalize the spec'd dashboard alias { mode: 'youtube', url } to the
  // existing { mode: 'stream', source } shape. URL must look like YouTube.
  let mode: SessionMode;
  let source: string;
  if (body.mode === 'youtube') {
    if (!body.url || typeof body.url !== 'string') {
      return res.status(400).json({ error: 'url required for mode=youtube' });
    }
    if (!/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(body.url)) {
      return res.status(400).json({ error: 'url must be a youtube.com or youtu.be URL' });
    }
    mode = 'stream';
    source = body.url;
  } else if (body.mode === 'stream' || body.mode === 'system-audio') {
    if (!body.source || typeof body.source !== 'string') {
      return res.status(400).json({ error: 'source required' });
    }
    mode = body.mode;
    source = body.source;
  } else {
    return res.status(400).json({ error: "mode must be 'youtube', 'stream' or 'system-audio'" });
  }

  const { speakerMap, startOffsetSeconds } = body;
  if (
    startOffsetSeconds !== undefined &&
    (typeof startOffsetSeconds !== 'number' ||
      !Number.isInteger(startOffsetSeconds) ||
      startOffsetSeconds < 0)
  ) {
    return res.status(400).json({ error: 'startOffsetSeconds must be a non-negative integer' });
  }
  if (deepgram.isActive()) {
    return res.status(409).json({ error: 'Session already active. Stop it first.' });
  }

  // Reset per-session classifier state. Stats are intentionally cumulative
  // across sessions — clear with a fresh process if the producer wants to.
  lastSegments.length = 0;
  activeSpans.length = 0;
  currentSpeakerMap = validateSpeakerMap(speakerMap);

  setSessionState('connecting', source);
  const sessionId = crypto.randomUUID();

  const startPromise = deepgram.startSession({
    mode,
    source,
    startOffsetSeconds: typeof startOffsetSeconds === 'number' ? startOffsetSeconds : undefined,
  });
  pendingStart = startPromise.then(
    () => {
      pendingStart = null;
    },
    () => {
      pendingStart = null;
    }
  );
  try {
    await startPromise;
    res.json({ status: 'connecting', sessionId });
  } catch (err) {
    const se = toSessionError(err);
    console.error(`[session/start] code=${se.code} message="${se.message}"`);
    // startSession threw before the deepgram socket opened — transition to
    // 'error' with the structured cause so the dashboard renders something
    // actionable instead of bouncing back to idle with no explanation.
    setSessionState('error', undefined, se);
    res.status(500).json({ error: se.message, code: se.code });
  }
});

app.post('/api/session/stop', async (_req, res) => {
  if (!deepgram) {
    return res.status(503).json({ error: 'DEEPGRAM_API_KEY not configured' });
  }
  // If a startSession is mid-flight, let it finish (or fail) before checking
  // isActive() — otherwise we report 'already_stopped' while ffmpeg/ws are
  // still coming up, and the half-built session orphans those processes.
  if (pendingStart) {
    await pendingStart.catch(() => {});
  }
  if (!deepgram.isActive()) {
    setSessionState('idle');
    return res.json({ status: 'already_stopped' });
  }
  try {
    await deepgram.stopSession();
    setSessionState('idle');
    res.json({ status: 'stopped' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[session/stop] ${msg}`);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/session/status', (_req, res) => {
  if (!deepgram) {
    return res.json({
      state: 'idle' as SessionUiState,
      url: null,
      startedAt: null,
      error: null,
      active: false,
      mode: null,
      uptime: null,
      configured: false,
    });
  }
  // effectiveSpeakerMap: what consumers should actually use. Operator-provided
  // map wins; absent that, fall back to the classifier's legacy default
  // (speaker 0 = host, speaker 1 = guest) so the dashboard renders HOST/GUEST
  // even for sessions started without an explicit map. The raw `speakerMap`
  // is preserved for backward compat; `speakerMapSource` lets callers tell
  // the two apart.
  const mapIsExplicit = Object.keys(currentSpeakerMap).length > 0;
  const effectiveSpeakerMap = mapIsExplicit ? currentSpeakerMap : { 0: 'host', 1: 'guest' };
  res.json({
    state: sessionState,
    url: sessionUrl,
    startedAt: sessionStartedAt,
    error: lastSessionError,
    active: deepgram.isActive(),
    mode: deepgram.getMode(),
    uptime: deepgram.getUptime(),
    configured: true,
    speakerMap: currentSpeakerMap,
    effectiveSpeakerMap,
    speakerMapSource: mapIsExplicit ? 'explicit' : 'default',
  });
});

app.get('/api/queue/stats', (_req, res) => {
  res.json({ queue: queueStats(), breakers: getBreakerState() });
});

app.get('/api/classifier/stats', (_req, res) => {
  const { segmentsProcessed, segmentsSkippedBySpan, claimsDetected, claimsByHost, claimsByCohost, claimsByGuest, sumConfidence, sumLatencyMs } = classifierStats;
  res.json({
    segmentsProcessed,
    segmentsSkippedBySpan,
    claimsDetected,
    claimsByHost,
    claimsByCohost,
    claimsByGuest,
    averageConfidence: claimsDetected > 0 ? sumConfidence / claimsDetected : 0,
    averageLatencyMs: segmentsProcessed > 0 ? sumLatencyMs / segmentsProcessed : 0,
    confidenceThreshold: CLAIM_CONFIDENCE_THRESHOLD,
    activeSpans: activeSpans.length,
  });
});

// ─── WebSocket Server ───

const server = createServer(app);
// Mount WS on the HTTP server so the whole app binds to one port — PaaS
// (Railway, Fly.io) only exposes a single port per service.
//
// Auth: browser WebSocket API can't set custom headers, so the client
// passes the token via ?token=... query param. The token appears in
// Railway's HTTP access logs as part of the upgrade request path — rotate
// if log access is ever shared. Acceptable tradeoff for a single-token
// share-with-one-teammate gate; not suitable for multi-user auth.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info, cb) => {
    if (!AUTH_ENABLED) return cb(true);
    const url = new URL(info.req.url || '', `http://${info.req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token !== ACCESS_TOKEN) return cb(false, 401, 'Unauthorized');
    cb(true);
  },
});

const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[ws] Client connected (${clients.size} total)`);

  // Send initial status. When Ollama isn't needed (cloud embed mode), always
  // report connected — its real availability is irrelevant to the dashboard.
  const status: StatusMessage = {
    type: 'status',
    state: !OLLAMA_NEEDED || isOllamaAvailable() ? 'connected' : 'ollama_down',
  };
  ws.send(JSON.stringify(status));

  ws.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg && msg.type === 'card_rendered' && typeof msg.claimId === 'string' && typeof msg.renderCompleteMs === 'number') {
      console.log(`[ttfc-client] claimId=${msg.claimId} renderCompleteMs=${msg.renderCompleteMs}`);
      const anchor = ttfcUtteranceEndMs.get(msg.claimId);
      if (anchor !== undefined) {
        const deltaMs = msg.renderCompleteMs - anchor;
        console.log(`[ttfc-paired] claimId=${msg.claimId} deltaMs=${deltaMs}`);
        const stages = getStages(msg.claimId);
        const wsReceivedMs = typeof msg.wsReceivedMs === 'number' ? msg.wsReceivedMs : undefined;
        if (
          stages?.classifierEndMs !== undefined &&
          stages.retrievalStartMs !== undefined &&
          stages.retrievalEndMs !== undefined &&
          stages.synthesisEndMs !== undefined &&
          stages.broadcastSendMs !== undefined &&
          wsReceivedMs !== undefined
        ) {
          const classifierMs = stages.classifierEndMs - anchor;
          const queueMs = stages.retrievalStartMs - stages.classifierEndMs;
          const retrievalMs = stages.retrievalEndMs - stages.retrievalStartMs;
          const synthesisMs = stages.synthesisEndMs - stages.retrievalEndMs;
          const wsTransitMs = wsReceivedMs - stages.broadcastSendMs;
          const browserRenderMs = msg.renderCompleteMs - wsReceivedMs;
          console.log(
            `[ttfc-attribution] claimId=${msg.claimId} total=${deltaMs} classifier=${classifierMs} queue=${queueMs} retrieval=${retrievalMs} synthesis=${synthesisMs} wsTransit=${wsTransitMs} browserRender=${browserRenderMs}`
          );
        }
        dropStages(msg.claimId);
        ttfcUtteranceEndMs.delete(msg.claimId);
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] Client disconnected (${clients.size} total)`);
  });
});

function broadcast(
  message:
    | TrollReaction
    | StatusMessage
    | TranscriptSegmentMessage
    | ClaimDetectedMessage
    | CardBroadcast
    | SessionStateMessage
): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

async function main() {
  // Check Ollama on startup — only when it's actually needed for embeddings
  // or the classifier fallback. EMBED_PROVIDER=openai deploys skip this.
  if (OLLAMA_NEEDED) {
    const ollamaOk = await checkOllama();
    if (!ollamaOk) {
      console.warn('⚠️  Ollama not detected at', appConfig.ollamaBaseUrl);
      console.warn('   Start Ollama and pull the model: ollama pull qwen2.5:7b');
      console.warn('   Sentinel will retry when utterances arrive.');
    } else {
      console.log('✅ Ollama connected');
    }
  }

  // Warmup LanceDB embedding path so the first claim doesn't hit 300ms
  // cold-start timeout. context.ts opens the connection at module load,
  // but the embedding side stays cold until the first queryMemory call.
  try {
    const { queryMemory } = await import('./episodeMemory.js');
    await queryMemory('startup funding venture capital', 1);
    console.log('[LANCEDB] Warmup complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[LANCEDB] Warmup failed — first query may timeout: ${msg}`);
  }

  // Start Express server
  server.listen(appConfig.port, () => {
    console.log('');
    console.log('🔴 TWiST Sentinel is running');
    console.log(`   Config:    http://localhost:${appConfig.port}/config`);
    console.log(`   WebSocket: ws://localhost:${appConfig.port}/ws`);
    console.log(`   Auth:      ${AUTH_ENABLED ? 'enabled' : 'disabled (SENTINEL_ACCESS_TOKEN unset)'}`);
    console.log('');
  });

  // Periodic Ollama health check — only when Ollama is actually load-bearing.
  if (OLLAMA_NEEDED) {
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
