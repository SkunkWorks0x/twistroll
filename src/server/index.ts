import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { appConfig } from '../config/config.js';
import { checkOllama, isOllamaAvailable } from './ollama.js';
import { commitEpisode } from './episodeMemory.js';
import { loadDossier, setCurrentDossier } from './dossier.js';
import { DeepgramClient, SessionMode } from './deepgram.js';
import { SpeakerMap } from './classifier.js';
import {
  enqueueClassifierTask,
  setClassifierHandlers,
  classifierQueueStats,
} from './classifierQueue.js';
import { enqueueClaim, queueStats, setProcessHandler, setRetrievalStartHandler } from './claimQueue.js';
import { getBreakerState } from './retrieval.js';
import { synthesize } from './synthesis.js';
import { recordStage, getStages, dropStages, clearAllStages } from './ttfcStages.js';
import type {
  TrollReaction,
  StatusMessage,
  TranscriptSegmentMessage,
  ClaimDetectedMessage,
  ClaimProgressMessage,
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

interface DeepgramHealthState {
  state: 'connected' | 'reconnecting' | 'disconnected';
  attempt?: number;
  cause?: string;
}
interface DeepgramHealthMessage extends DeepgramHealthState {
  type: 'deepgram_health';
}
let deepgramHealth: DeepgramHealthState | null = null;
let currentSpeakerNames: Record<number, string> = {};

function setDeepgramHealth(next: DeepgramHealthState): void {
  if (
    deepgramHealth &&
    deepgramHealth.state === next.state &&
    deepgramHealth.attempt === next.attempt &&
    deepgramHealth.cause === next.cause
  ) return;
  deepgramHealth = next;
  const msg: DeepgramHealthMessage = { type: 'deepgram_health', state: next.state };
  if (next.attempt !== undefined) msg.attempt = next.attempt;
  if (next.cause !== undefined) msg.cause = next.cause;
  broadcast(msg);
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

// claimId → utteranceEndMs (epoch ms at is_final receipt). 200-entry cap
// plus a 5-min TTL so claims that never get a card_rendered ack don't
// leak forever.
const TTFC_MAP_MAX = 200;
const TTFC_ANCHOR_TTL_MS = 5 * 60 * 1000;
const ttfcUtteranceEndMs = new Map<string, number>();
function recordTtfcAnchor(claimId: string, ms: number): void {
  const now = Date.now();
  for (const [k, ts] of ttfcUtteranceEndMs) {
    if (now - ts > TTFC_ANCHOR_TTL_MS) ttfcUtteranceEndMs.delete(k);
    else break;
  }
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

setClassifierHandlers(
  ({ classification, latencyMs, task }) => {
    const classifierEndMs = Date.now();
    classifierStats.segmentsProcessed++;
    classifierStats.sumLatencyMs += latencyMs;

    if (classification.isClaim && classification.confidence >= CLAIM_CONFIDENCE_THRESHOLD) {
      classifierStats.claimsDetected++;
      classifierStats.sumConfidence += classification.confidence;
      if (classification.speaker === 'host') classifierStats.claimsByHost++;
      else if (classification.speaker === 'cohost') classifierStats.claimsByCohost++;
      else classifierStats.claimsByGuest++;

      markSpanActive(task.window, classification.claimSpan);
      broadcast({ type: 'claim_detected', data: classification });
      console.log(
        `[CLASSIFIER] Claim detected: "${classification.claimText}" (speaker: ${classification.speaker}, confidence: ${classification.confidence.toFixed(2)})`
      );

      recordStage(classification.segmentId, 'classifierEndMs', classifierEndMs);
      const enqueueResult = enqueueClaim(classification, lastSegments);
      // Only emit 'detected' progress for claims that survived the gate stack
      // (sponsor/weak-entity/cooldown/dedup). Suppressed claims would render
      // a pending card that never resolves.
      if (enqueueResult.enqueued) {
        broadcast({
          type: 'claim_progress',
          claimId: classification.segmentId,
          stage: 'detected',
          primaryEntity: classification.primaryEntity,
          claimText: classification.claimText.slice(0, 60),
        });
      }
    } else if (classification.isClaim) {
      console.log(
        `[CLASSIFIER] Claim below threshold (${classification.confidence.toFixed(2)} < ${CLAIM_CONFIDENCE_THRESHOLD}): "${classification.claimText}"`
      );
      console.log(`[classifier-suppress] reason=low_confidence confidence=${classification.confidence.toFixed(2)} claimText="${classification.claimText.slice(0, 50)}"`);
    } else {
      console.log(`[CLASSIFIER] No claim: "${classification.reason}"`);
      console.log(`[classifier-suppress] reason=not_a_claim segmentId=${task.segmentId}`);
    }
  },
  (err, _task) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[classifier] unhandled error: ${msg}`);
  }
);

// Shared segment ingest — called by Deepgram's 'segment' event in live mode,
// and by the replay loop in demo mode. Both paths must run the same gate
// stack and classifier so cards are live-generated either way.
function processIncomingSegment(segment: TranscriptSegment): void {
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

  enqueueClassifierTask({
    window,
    prior,
    speakerMap: currentSpeakerMap,
    segmentId: segment.id,
    enqueuedAt: Date.now(),
  });
}

if (deepgram) {
  deepgram.on('segment', (segment: TranscriptSegment) => {
    processIncomingSegment(segment);
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
    setDeepgramHealth({ state: 'reconnecting', attempt });
  });
  deepgram.on('connected', () => setDeepgramHealth({ state: 'connected' }));
  deepgram.on('disconnected', () => setDeepgramHealth({ state: 'disconnected' }));
  deepgram.on('reresolving', ({ attempt, cause }: { attempt: number; cause: string }) => {
    setDeepgramHealth({ state: 'reconnecting', attempt, cause });
  });
  deepgram.on('reresolved', () => setDeepgramHealth({ state: 'connected' }));
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

function validateSpeakerNames(input: unknown): Record<number, string> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const id = parseInt(k, 10);
    if (Number.isNaN(id) || typeof v !== 'string') continue;
    const label = v.trim().slice(0, 32);
    if (label) out[id] = label;
  }
  return out;
}

// ─── Synthesis pipeline: claim queue → retrieval → synthesis → broadcast ─
setRetrievalStartHandler((claim) => {
  broadcast({
    type: 'claim_progress',
    claimId: claim.segmentId,
    stage: 'retrieving',
    primaryEntity: claim.primaryEntity,
    claimText: claim.claimText.slice(0, 60),
  });
});

setProcessHandler(async ({ claim, segmentSnapshot, retrieval }) => {
  try {
    const triggerSeg = segmentSnapshot.find((s) => s.id === claim.segmentId);
    const utteranceEndMs = triggerSeg ? triggerSeg.createdAt : Date.now();
    recordTtfcAnchor(claim.segmentId, utteranceEndMs);
    console.log(`[ttfc-server] claimId=${claim.segmentId} utteranceEndMs=${utteranceEndMs}`);
    broadcast({
      type: 'claim_progress',
      claimId: claim.segmentId,
      stage: 'analyzing',
      primaryEntity: claim.primaryEntity,
      claimText: claim.claimText.slice(0, 60),
    });
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
    speakerNames?: unknown;
    sessionContext?: { speakerNames?: unknown };
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
  } else if (body.mode === 'stream') {
    if (!body.source || typeof body.source !== 'string') {
      return res.status(400).json({ error: 'source required for mode=stream' });
    }
    mode = 'stream';
    source = body.source;
  } else if (body.mode === 'system-audio') {
    // Device-name resolution chain: explicit body.source → AUDIO_DEVICE env →
    // BlackHole 2ch default. Spec'd so the dashboard can send just
    // { mode: 'system-audio' } without a device-picker UI.
    mode = 'system-audio';
    source =
      (typeof body.source === 'string' && body.source.trim()) ||
      process.env.AUDIO_DEVICE ||
      'BlackHole 2ch';
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
  ttfcUtteranceEndMs.clear();
  clearAllStages();
  // Bare reset (no broadcast) — fresh session will broadcast on first event.
  deepgramHealth = null;
  currentSpeakerMap = validateSpeakerMap(speakerMap);
  currentSpeakerNames = validateSpeakerNames(body.speakerNames ?? body.sessionContext?.speakerNames);

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

// ─── Demo replay path ──────────────────────────────────────────
// JSONL transcript playback for the hosted "Try with latest TWiST" button.
// Lets the dashboard demo end-to-end even when Railway YouTube ingest is
// blocked (no proxy, soft-block, etc.). Each line is a TranscriptSegment-
// shaped record; missing fields are filled in at replay time. Segments are
// scheduled by their `timestamp` (seconds from start) so retrieval/synthesis
// see the same cadence the real pipeline would have produced.
const DEMO_DIR = resolve(__dirname, '..', '..', 'data', 'demo');
const DEMO_YOUTUBE_URL = process.env.DEMO_YOUTUBE_URL?.trim() || 'https://www.youtube.com/@TWiStartups';
const DEMO_FORCE_REPLAY = process.env.DEMO_FORCE_REPLAY === '1';

interface ReplaySegmentRecord {
  text: string;
  speaker?: number;
  speakerLabel?: string;
  timestamp?: number;  // seconds from session start
  duration?: number;
  confidence?: number;
}

let replayActive = false;
const replayTimers: NodeJS.Timeout[] = [];

function listReplayFiles(): string[] {
  if (!existsSync(DEMO_DIR)) return [];
  return readdirSync(DEMO_DIR).filter((f) => f.endsWith('.jsonl')).sort();
}

function loadReplayFile(filename: string): ReplaySegmentRecord[] {
  const path = join(DEMO_DIR, filename);
  const raw = readFileSync(path, 'utf-8');
  const records: ReplaySegmentRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.text === 'string') records.push(obj as ReplaySegmentRecord);
    } catch {
      // Skip malformed lines — replay must not crash on a single bad row.
    }
  }
  return records;
}

function clearReplay(): void {
  for (const t of replayTimers) clearTimeout(t);
  replayTimers.length = 0;
  replayActive = false;
}

function startReplay(records: ReplaySegmentRecord[], displayUrl: string): void {
  replayActive = true;
  setSessionState('connecting', displayUrl);
  // First segment fires immediately; subsequent ones are spaced by the gap
  // between their timestamps. If timestamps are missing or non-monotonic,
  // fall back to `duration` of the previous segment, then to 2s.
  let prevTs = 0;
  let cumulativeDelayMs = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const ts = typeof r.timestamp === 'number' ? r.timestamp : prevTs + (records[i - 1]?.duration ?? 2);
    const gapSec = i === 0 ? 0 : Math.max(0, ts - prevTs);
    cumulativeDelayMs += gapSec * 1000;
    const speakerNum = typeof r.speaker === 'number' ? r.speaker : 0;
    const captureTs = ts;
    const t = setTimeout(() => {
      if (!replayActive) return;
      const segment: TranscriptSegment = {
        id: randomUUID(),
        text: r.text.trim(),
        speaker: speakerNum,
        speakerLabel: r.speakerLabel || `Speaker ${speakerNum}`,
        timestamp: captureTs,
        duration: typeof r.duration === 'number' ? r.duration : 0,
        isFinal: true,
        confidence: typeof r.confidence === 'number' ? r.confidence : 0.95,
        createdAt: Date.now(),
      };
      processIncomingSegment(segment);
    }, cumulativeDelayMs);
    replayTimers.push(t);
    prevTs = ts;
  }
  // After the last segment, hold 'live' state for 10s then return to 'idle'.
  const closeoutMs = cumulativeDelayMs + 10_000;
  const closeoutTimer = setTimeout(() => {
    if (!replayActive) return;
    console.log('[demo] replay complete — returning to idle');
    clearReplay();
    setSessionState('idle');
  }, closeoutMs);
  replayTimers.push(closeoutTimer);
  console.log(`[demo] replay started: ${records.length} segments, ~${Math.round(cumulativeDelayMs / 1000)}s total`);
}

app.post('/api/session/demo', async (req, res) => {
  const body = (req.body || {}) as { replay?: boolean; file?: string };
  const forceReplay = body.replay === true || DEMO_FORCE_REPLAY;

  if (deepgram?.isActive() || replayActive) {
    return res.status(409).json({ error: 'Session already active. Stop it first.' });
  }

  // Reset per-session state — same as /api/session/start.
  lastSegments.length = 0;
  activeSpans.length = 0;
  ttfcUtteranceEndMs.clear();
  clearAllStages();
  deepgramHealth = null;

  // Path 1: try live YouTube first unless forced to replay.
  if (!forceReplay && deepgram) {
    setSessionState('connecting', DEMO_YOUTUBE_URL);
    const sessionId = randomUUID();
    try {
      await deepgram.startSession({ mode: 'stream', source: DEMO_YOUTUBE_URL });
      return res.json({ status: 'connecting', mode: 'live', sessionId, source: DEMO_YOUTUBE_URL });
    } catch (err) {
      const se = toSessionError(err);
      console.warn(`[demo] live attempt failed code=${se.code} — falling back to replay`);
      // Don't surface the live failure as a session error; we're falling back.
      setSessionState('idle');
    }
  }

  // Path 2: cached replay.
  const files = listReplayFiles();
  const chosen = (body.file && files.includes(body.file)) ? body.file : files[0];
  if (!chosen) {
    setSessionState('error', undefined, {
      code: 'UNKNOWN_SESSION_ERROR',
      source: 'server',
      message: 'No demo replay files found.',
      detail: `Expected at least one .jsonl in ${DEMO_DIR}`,
      hint: 'Add a cached transcript or set YTDLP_PROXY so the live path works.',
      retryable: false,
    });
    return res.status(503).json({ error: 'No demo replay files available', detail: `Place a .jsonl in ${DEMO_DIR}` });
  }
  let records: ReplaySegmentRecord[];
  try {
    records = loadReplayFile(chosen);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to load replay file ${chosen}: ${msg}` });
  }
  if (records.length === 0) {
    return res.status(500).json({ error: `Replay file ${chosen} contained no valid segments` });
  }
  startReplay(records, `demo://${chosen}`);
  res.json({ status: 'connecting', mode: 'replay', file: chosen, segments: records.length, source: `demo://${chosen}` });
});

app.post('/api/session/speakers', (req, res) => {
  const body = req.body as { speakerMap?: unknown; speakerNames?: unknown };
  currentSpeakerMap = validateSpeakerMap(body.speakerMap);
  currentSpeakerNames = validateSpeakerNames(body.speakerNames);
  res.json({
    status: 'ok',
    speakerMap: currentSpeakerMap,
    sessionContext: { speakerNames: currentSpeakerNames },
  });
});

app.post('/api/session/stop', async (_req, res) => {
  // Replay mode has no Deepgram connection — just cancel timers and idle.
  if (replayActive) {
    clearReplay();
    setSessionState('idle');
    ttfcUtteranceEndMs.clear();
    clearAllStages();
    return res.json({ status: 'stopped', mode: 'replay' });
  }
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
    ttfcUtteranceEndMs.clear();
    clearAllStages();
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
    sessionContext: { speakerNames: currentSpeakerNames },
    deepgramHealth,
    reResolutionAttempts: deepgram.getReResolutionAttempts(),
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
    ...classifierQueueStats(),
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
  if (deepgramHealth) {
    const hm: DeepgramHealthMessage = { type: 'deepgram_health', state: deepgramHealth.state };
    if (deepgramHealth.attempt !== undefined) hm.attempt = deepgramHealth.attempt;
    ws.send(JSON.stringify(hm));
  }

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
    | ClaimProgressMessage
    | CardBroadcast
    | SessionStateMessage
    | DeepgramHealthMessage
): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal} — draining`);

  // Fallback hard-exit so a stuck close() can't keep the container alive
  // past Railway/Fly SIGKILL grace window.
  setTimeout(() => {
    console.warn('[shutdown] drain timed out — forcing exit');
    process.exit(1);
  }, 10_000).unref();

  if (replayActive) {
    clearReplay();
  }
  if (deepgram?.isActive()) {
    try { await deepgram.stopSession(); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[shutdown] stopSession failed: ${msg}`);
    }
  }

  for (const ws of clients) {
    try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
  }

  await Promise.all([
    new Promise<void>((resolve) => wss.close(() => resolve())),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);

  console.log('[shutdown] complete');
  process.exit(0);
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error(`[unhandled-rejection] ${msg}`);
});

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
