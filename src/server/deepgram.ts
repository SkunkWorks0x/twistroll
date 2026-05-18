// Deepgram Nova-3 streaming client. Two input modes (stream URL vs. macOS
// avfoundation device) collapse to the same Deepgram WS connection.
//
// Implementation note: @deepgram/sdk is installed as a dependency but not used
// here — the v5 SDK is Fern-generated and adds friction over the small set of
// WS messages we need. Raw `ws` gives 1:1 control over the config below.

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import WebSocket, { RawData } from 'ws';
import { randomUUID } from 'crypto';
import type { SessionError, TranscriptSegment } from '../shared/types.js';

// Error subclass carrying a structured SessionError. emit('error', ...) sites
// in this file construct one of these so index.ts can surface a specific
// cause to the dashboard instead of a generic 'Session failed'.
export class SessionPipelineError extends Error {
  readonly sessionError: SessionError;
  constructor(se: SessionError) {
    super(se.message);
    this.name = 'SessionPipelineError';
    this.sessionError = se;
  }
}

const STDERR_TAIL_MAX = 4096; // bytes — bounded buffer for child-process stderr
function appendBounded(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > STDERR_TAIL_MAX ? next.slice(-STDERR_TAIL_MAX) : next;
}

// yt-dlp stderr can echo the input URL, which may contain query params / auth.
// Redact before any stderr substring lands in a dashboard-bound `detail`.
function redactUrls(s: string): string {
  return s.replace(/https?:\/\/\S+/g, '<url>');
}

// Classify yt-dlp's stderr tail into a SessionError. Patterns match the
// soft-block signatures YouTube serves to flagged data-center IPs (cf.
// yt-dlp issues #16072, #15865, #15751 — same code, only the flagged host
// sees the failure). Order matters: bot-check first, then the lying-not-live
// fallback, then the generic unavailable, then catch-all. Do NOT alphabetize.
function classifyYtdlpError(exitCode: number, stderr: string): SessionError {
  const safe = redactUrls(stderr);
  if (/sign in to confirm/i.test(safe)) {
    return {
      code: 'YOUTUBE_BOT_CHECK',
      source: 'yt-dlp',
      message: 'YouTube blocked the hosted server.',
      detail: 'yt-dlp returned: "Sign in to confirm you are not a bot."',
      hint: 'Use a local source relay or run Sentinel from a residential network. Railway/Fly/AWS IPs are often blocked by YouTube.',
      retryable: false,
    };
  }
  if (/not currently live/i.test(safe)) {
    return {
      code: 'YOUTUBE_NOT_LIVE_OR_BLOCKED',
      source: 'yt-dlp',
      message: 'YouTube says this channel is not currently live (or this is a soft-block).',
      detail: 'yt-dlp returned: "The channel is not currently live."',
      hint: 'YouTube serves this same message to flagged data-center IPs even when the stream IS live. Try from a residential network to confirm.',
      retryable: false,
    };
  }
  if (/video unavailable/i.test(safe)) {
    return {
      code: 'YOUTUBE_UNAVAILABLE_OR_BLOCKED',
      source: 'yt-dlp',
      message: 'YouTube reported the video as unavailable.',
      detail: 'yt-dlp returned: "Video unavailable."',
      hint: 'May be a real takedown, geo-block, or a data-center IP soft-block. Verify the URL in a browser first.',
      retryable: false,
    };
  }
  return {
    code: 'YTDLP_EXIT_NONZERO',
    source: 'yt-dlp',
    message: `yt-dlp exited with code ${exitCode}.`,
    detail: safe ? `Last stderr: ${safe.slice(-500).trim()}` : undefined,
    retryable: true,
  };
}

// HLS 403s surface here, not in yt-dlp's --get-url call. Manifest may parse
// at resolve time but segment fetches hit YouTube's per-segment IP check.
// avfoundation permission denial at CAPTURE time also surfaces here — the
// stable anchor is ffmpeg's own "Failed to create AV capture input device"
// prefix (see ffmpeg/libavdevice/avfoundation.m). The "Cannot use <name>"
// suffix is Apple's NSError text and varies by device.
function classifyFfmpegError(exitCode: number | null, stderr: string): SessionError {
  const safe = redactUrls(stderr);
  if (/Failed to create AV capture input device/i.test(safe)) {
    return avfoundationPermissionDenied(
      safe ? `ffmpeg stderr: ${safe.slice(-500).trim()}` : undefined
    );
  }
  if (/HTTP Error 403|HTTP_403|HTTP error 403|403 Forbidden/i.test(safe)) {
    return {
      code: 'YOUTUBE_HLS_FORBIDDEN',
      source: 'ffmpeg',
      message: 'YouTube refused the HLS segment fetch.',
      detail: 'ffmpeg got HTTP 403 on a segment URL.',
      hint: 'Manifest parsed but segment fetch was rejected — typical for flagged IPs. Residential egress is the reliable fix.',
      retryable: true,
    };
  }
  return {
    code: 'FFMPEG_EXIT_NONZERO',
    source: 'ffmpeg',
    message: `ffmpeg exited with code ${exitCode}.`,
    detail: safe ? `Last stderr: ${safe.slice(-500).trim()}` : undefined,
    retryable: true,
  };
}

function deepgramDisconnectError(detail: string): SessionError {
  return {
    code: 'DEEPGRAM_DISCONNECTED',
    source: 'deepgram',
    message: 'Deepgram connection failed.',
    detail,
    retryable: true,
  };
}

function avfoundationDeviceNotFound(deviceName: string): SessionError {
  return {
    code: 'AVFOUNDATION_DEVICE_NOT_FOUND',
    source: 'ffmpeg',
    message: `Audio device "${deviceName}" not found.`,
    hint: 'Install BlackHole 2ch, route system/Zoom audio to it, then retry. You can override the device with AUDIO_DEVICE.',
    retryable: false,
  };
}

function avfoundationPermissionDenied(detail?: string): SessionError {
  return {
    code: 'AVFOUNDATION_PERMISSION_DENIED',
    source: 'ffmpeg',
    message: 'macOS denied audio capture permission to this process.',
    detail,
    hint: 'Grant microphone permission to Terminal/iTerm/VS Code in macOS System Settings → Privacy & Security → Microphone, then restart Sentinel.',
    retryable: false,
  };
}

export type SessionMode = 'stream' | 'system-audio';

export interface SessionConfig {
  mode: SessionMode;
  source: string;
  startOffsetSeconds?: number;
}

const DG_WS_URL = 'wss://api.deepgram.com/v1/listen';
const DG_QUERY_PARAMS = {
  model: 'nova-3',
  diarize: 'true',
  smart_format: 'true',
  punctuate: 'true',
  endpointing: '400',
  encoding: 'linear16',
  sample_rate: '16000',
  channels: '1',
};

const KEEPALIVE_INTERVAL_MS = 8000;
// Exponential backoff schedule, capped at 30s.
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;
const RECONNECT_JITTER_PCT = 0.2;
const CONNECT_TIMEOUT_MS = 5000;
// Bounded audio buffer — at 16kHz mono s16le, ffmpeg emits ~2KB chunks every
// ~30-60ms. 200 chunks ≈ 6-12s of audio. If WS is down longer than this, we
// drop the oldest chunks (newest stays — losing the start of a reconnection
// gap is preferable to losing the resumption).
const AUDIO_BUFFER_MAX_CHUNKS = 200;

export class DeepgramClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private ffmpeg: ChildProcess | null = null;
  private ytdlp: ChildProcess | null = null;
  private ytdlpStderr = '';
  private ffmpegStderr = '';
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private active = false;
  private sessionConfig: SessionConfig | null = null;
  private sessionStart = 0;
  private apiKey: string;
  private audioBuffer: Buffer[] = [];
  private intentionalStop = false;

  constructor(apiKey: string) {
    super();
    if (!apiKey) throw new Error('DeepgramClient requires apiKey');
    this.apiKey = apiKey;
  }

  isActive(): boolean {
    return this.active;
  }

  getUptime(): number | null {
    return this.active ? (Date.now() - this.sessionStart) / 1000 : null;
  }

  getMode(): SessionMode | null {
    return this.sessionConfig?.mode ?? null;
  }

  async startSession(config: SessionConfig): Promise<void> {
    if (this.active) {
      throw new Error('Session already active. Call stopSession first.');
    }
    this.sessionConfig = config;
    this.sessionStart = Date.now();
    this.active = true;
    this.intentionalStop = false;
    this.reconnectAttempt = 0;
    this.audioBuffer = [];

    try {
      await this.connectDeepgram();
      this.startAudioPipeline();
    } catch (err) {
      this.rollbackActive();
      throw err;
    }
    const offsetSuffix = config.startOffsetSeconds !== undefined ? `, startOffsetSeconds=${config.startOffsetSeconds}` : '';
    console.log(`[deepgram] session started: mode=${config.mode}, source="${config.source}"${offsetSuffix}`);
  }

  async stopSession(): Promise<void> {
    if (!this.active) return;
    this.intentionalStop = true;
    this.active = false;
    this.stopKeepAlive();
    this.killAudioPipeline();
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          // Tell Deepgram to flush pending finals before close.
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        this.ws.close();
      } catch (err) {
        console.warn(`[deepgram] WS close error: ${err}`);
      }
      this.ws = null;
    }
    this.audioBuffer = [];
    this.sessionConfig = null;
    console.log('[deepgram] session stopped');
  }

  // Without this, an async failure wedges active=true and retries 409.
  private rollbackActive(): void {
    this.active = false;
    this.intentionalStop = true;
    this.stopKeepAlive();
    this.killAudioPipeline();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.audioBuffer = [];
    this.sessionConfig = null;
  }

  // ─── Deepgram WebSocket ────────────────────────────────────────────────

  private async connectDeepgram(): Promise<void> {
    const queryString = new URLSearchParams(DG_QUERY_PARAMS).toString();
    const url = `${DG_WS_URL}?${queryString}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      // `settled` prevents double-resolve/reject from the multiple ws events
      // that fire on auth failure (error → close → timeout). `opened` lets
      // the close handler distinguish a pre-open failure (must reject the
      // initial connect Promise) from a post-open disconnect (triggers
      // reconnect logic, original Promise already resolved).
      let opened = false;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.terminate();
          settle(() => reject(new SessionPipelineError(deepgramDisconnectError(
            `Deepgram WS connect timeout (${CONNECT_TIMEOUT_MS}ms)`
          ))));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timeout);
        opened = true;
        console.log('[deepgram] WS connected');
        this.startKeepAlive();
        // Per-incident reset so a future blip starts from attempt=1.
        if (this.reconnectAttempt > 0) {
          console.log(`[deepgram] reconnected after ${this.reconnectAttempt} attempt(s)`);
          this.reconnectAttempt = 0;
          this.emit('reconnected');
        }
        this.emit('connected');
        settle(() => resolve());
      });

      ws.on('message', (data) => this.handleMessage(data));

      ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        console.warn(`[deepgram] WS closed: code=${code}, reason="${reason.toString() || '(none)'}"`);
        this.stopKeepAlive();
        this.emit('disconnected');
        if (!opened) {
          // Auth failure / network reset before WS opened. Reject the initial
          // connect Promise — without this it would hang forever, blocking
          // the /api/session/start response and leaving `active` wedged.
          settle(() => reject(new SessionPipelineError(deepgramDisconnectError(
            `Deepgram WS closed before open (code=${code})`
          ))));
          return;
        }
        if (!this.intentionalStop && this.active) {
          this.attemptReconnect();
        }
      });

      ws.on('error', (err) => {
        console.error(`[deepgram] WS error: ${err.message}`);
        if (!opened) {
          clearTimeout(timeout);
          const wrapped = new SessionPipelineError(deepgramDisconnectError(err.message));
          this.emit('error', wrapped);
          settle(() => reject(wrapped));
        } else {
          this.emit('error', err);
        }
      });

      this.ws = ws;
    });
  }

  private handleMessage(data: RawData): void {
    let parsed: any;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON
    }

    if (parsed.type !== 'Results' || !parsed.is_final) return;
    const alt = parsed.channel?.alternatives?.[0];
    if (!alt) return;

    const text: string = alt.transcript || '';
    if (!text.trim()) return; // drop silence/empty finals

    // Diarization: each word carries a speaker id; we take the first word's
    // speaker as the segment's speaker. Cross-speaker segments are rare with
    // diarize=true since Deepgram closes a final on speaker change.
    const firstWord = alt.words?.[0];
    const speaker: number = typeof firstWord?.speaker === 'number' ? firstWord.speaker : 0;

    const segment: TranscriptSegment = {
      id: randomUUID(),
      text: text.trim(),
      speaker,
      speakerLabel: `Speaker ${speaker}`,
      timestamp: typeof parsed.start === 'number' ? parsed.start : 0,
      duration: typeof parsed.duration === 'number' ? parsed.duration : 0,
      isFinal: true,
      confidence: typeof alt.confidence === 'number' ? alt.confidence : 0,
      createdAt: Date.now(),
    };

    this.emit('segment', segment);
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        } catch (err) {
          console.warn(`[deepgram] keep-alive send failed: ${err}`);
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;

    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      const detail = `Deepgram WS reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts — giving up`;
      console.error(`[deepgram] CRITICAL: ${detail}`);
      this.emit('error', new SessionPipelineError(deepgramDisconnectError(detail)));
      this.reconnecting = false;
      this.rollbackActive();
      return;
    }

    this.reconnectAttempt++;
    const attempt = this.reconnectAttempt;
    const baseDelay = RECONNECT_BACKOFF_MS[attempt - 1];
    // ±RECONNECT_JITTER_PCT — desynchronizes simultaneous reconnects when
    // multiple clients drop on the same upstream blip.
    const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER_PCT;
    const delay = Math.round(baseDelay * jitter);
    console.warn(`[deepgram] reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    this.emit('reconnecting', { attempt });

    setTimeout(async () => {
      try {
        await this.connectDeepgram();
        this.reconnecting = false;
      } catch (err) {
        this.reconnecting = false;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[deepgram] reconnect attempt ${attempt} failed: ${msg}`);
      }
    }, delay);
  }

  // ─── Audio Pipeline ────────────────────────────────────────────────────

  private startAudioPipeline(): void {
    if (!this.sessionConfig) return;
    if (this.sessionConfig.mode === 'stream') {
      this.startStreamMode(this.sessionConfig.source);
    } else {
      this.startSystemAudioMode(this.sessionConfig.source);
    }
  }

  private startStreamMode(url: string): void {
    // Two-step: yt-dlp resolves the direct audio URL, then ffmpeg pulls and
    // converts to PCM. Splitting this way avoids piping yt-dlp's container
    // output through ffmpeg, which is fragile for live HLS streams.
    const ytdlp = spawn('yt-dlp', ['-f', 'bestaudio', '--get-url', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.ytdlp = ytdlp;
    this.ytdlpStderr = '';

    let directUrl = '';
    ytdlp.stdout.on('data', (chunk) => {
      directUrl += chunk.toString();
    });

    ytdlp.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      this.ytdlpStderr = appendBounded(this.ytdlpStderr, s);
      const msg = s.trim();
      if (msg) console.warn(`[yt-dlp] ${msg}`);
    });

    ytdlp.on('close', (code) => {
      this.ytdlp = null;
      if (!this.active) return;
      if (code !== 0) {
        const se = classifyYtdlpError(code ?? -1, this.ytdlpStderr);
        console.error(`[deepgram] yt-dlp failed: code=${se.code} message="${se.message}"`);
        this.rollbackActive();
        this.emit('error', new SessionPipelineError(se));
        return;
      }
      const cleanUrl = directUrl.trim().split('\n')[0];
      if (!cleanUrl) {
        const safe = redactUrls(this.ytdlpStderr);
        this.rollbackActive();
        this.emit('error', new SessionPipelineError({
          code: 'YTDLP_EXIT_NONZERO',
          source: 'yt-dlp',
          message: 'yt-dlp succeeded but returned no audio URL.',
          detail: safe ? `Last stderr: ${safe.slice(-500).trim()}` : undefined,
          retryable: true,
        }));
        return;
      }
      console.log('[deepgram] yt-dlp resolved direct audio URL');
      this.spawnFfmpegFromUrl(cleanUrl, this.sessionConfig?.startOffsetSeconds);
    });
  }

  private spawnFfmpegFromUrl(url: string, offsetSeconds?: number): void {
    const args: string[] = [];
    if (offsetSeconds !== undefined && offsetSeconds > 0) {
      args.push('-ss', String(offsetSeconds));
    }
    args.push(
      '-i', url,
      '-f', 's16le',
      '-ar', '16000',
      '-ac', '1',
      '-acodec', 'pcm_s16le',
      '-loglevel', 'warning',
      'pipe:1',
    );
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ffmpeg;
    this.attachFfmpegStreams(ffmpeg);
  }

  private startSystemAudioMode(deviceName: string): void {
    this.resolveAvfoundationIndex(deviceName)
      .then((idx) => {
        if (!this.active) return;
        const ffmpeg = spawn('ffmpeg', [
          '-f', 'avfoundation',
          '-i', `:${idx}`,
          '-f', 's16le',
          '-ar', '16000',
          '-ac', '1',
          '-acodec', 'pcm_s16le',
          '-loglevel', 'warning',
          'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        this.ffmpeg = ffmpeg;
        this.attachFfmpegStreams(ffmpeg);
      })
      .catch((err) => {
        const se = err instanceof SessionPipelineError
          ? err.sessionError
          : { code: 'FFMPEG_EXIT_NONZERO', source: 'ffmpeg', message: err.message, retryable: true } as SessionError;
        console.error(`[deepgram] system-audio start failed: code=${se.code}`);
        this.rollbackActive();
        this.emit('error', new SessionPipelineError(se));
      });
  }

  private resolveAvfoundationIndex(name: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = spawn('ffmpeg', [
        '-hide_banner',
        '-f', 'avfoundation',
        '-list_devices', 'true',
        '-i', '',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      probe.stderr.on('data', (c) => { stderr += c.toString(); });
      probe.on('close', () => {
        // Output format:
        //   [AVFoundation indev @ ...] AVFoundation video devices:
        //   [AVFoundation indev @ ...] [0] FaceTime HD Camera
        //   [AVFoundation indev @ ...] AVFoundation audio devices:
        //   [AVFoundation indev @ ...] [0] BlackHole 2ch
        //   [AVFoundation indev @ ...] [1] MacBook Pro Microphone
        const audioSection = stderr.split('AVFoundation audio devices:')[1];
        if (!audioSection) {
          // No "AVFoundation audio devices:" header in stderr at all —
          // ffmpeg couldn't load avfoundation. Treat as a generic probe
          // failure (almost always not-macOS or ffmpeg build without
          // avfoundation support).
          return reject(new SessionPipelineError({
            code: 'FFMPEG_EXIT_NONZERO',
            source: 'ffmpeg',
            message: 'Audio device probe failed (no avfoundation output).',
            detail: stderr ? `ffmpeg stderr: ${stderr.slice(-500).trim()}` : undefined,
            retryable: true,
          }));
        }
        // Ventura+ TCC denial returns the header with zero `[N]` rows.
        // No `[N]` markers in the audio section ⇒ permission denied.
        const hasAudioEntries = /\[\d+\]/.test(audioSection);
        if (!hasAudioEntries) {
          return reject(new SessionPipelineError(avfoundationPermissionDenied(
            'ffmpeg listed an empty AVFoundation audio devices section, which on macOS Ventura+ indicates TCC microphone-permission denial.'
          )));
        }
        const match = audioSection.split('\n').find((line) => line.includes(name));
        if (!match) {
          return reject(new SessionPipelineError(avfoundationDeviceNotFound(name)));
        }
        const m = match.match(/\[(\d+)\]\s/);
        if (!m) {
          return reject(new SessionPipelineError({
            code: 'FFMPEG_EXIT_NONZERO',
            source: 'ffmpeg',
            message: 'Could not parse audio device index from ffmpeg output.',
            detail: `Line: "${match.trim().slice(0, 200)}"`,
            retryable: true,
          }));
        }
        resolve(parseInt(m[1], 10));
      });
    });
  }

  private attachFfmpegStreams(ffmpeg: ChildProcess): void {
    if (!ffmpeg.stdout) {
      this.rollbackActive();
      this.emit('error', new SessionPipelineError({
        code: 'FFMPEG_EXIT_NONZERO',
        source: 'ffmpeg',
        message: 'ffmpeg stdout pipe missing.',
        retryable: true,
      }));
      return;
    }

    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      // Bounded buffer: drop oldest if full. Audio capture must never block.
      this.audioBuffer.push(chunk);
      while (this.audioBuffer.length > AUDIO_BUFFER_MAX_CHUNKS) {
        this.audioBuffer.shift();
        console.warn('[deepgram] audio buffer full — dropped oldest chunk');
      }

      // Drain to Deepgram if WS open.
      while (this.audioBuffer.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
        const next = this.audioBuffer.shift()!;
        try {
          this.ws.send(next);
        } catch {
          // Lost the WS mid-send: re-queue at front, exit loop. Reconnect
          // will pick up the buffer on the next chunk after WS reopens.
          this.audioBuffer.unshift(next);
          break;
        }
      }
    });

    this.ffmpegStderr = '';
    if (ffmpeg.stderr) {
      ffmpeg.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        this.ffmpegStderr = appendBounded(this.ffmpegStderr, s);
        const msg = s.trim();
        if (msg) console.warn(`[ffmpeg] ${msg}`);
      });
    }

    ffmpeg.on('close', (code) => {
      this.ffmpeg = null;
      if (this.active && !this.intentionalStop && code !== 0) {
        const se = classifyFfmpegError(code, this.ffmpegStderr);
        console.error(`[deepgram] ffmpeg failed: code=${se.code}`);
        this.rollbackActive();
        this.emit('error', new SessionPipelineError(se));
      }
    });
  }

  private killAudioPipeline(): void {
    if (this.ytdlp) {
      try { this.ytdlp.kill('SIGKILL'); } catch { /* ignore */ }
      this.ytdlp = null;
    }
    if (this.ffmpeg) {
      try { this.ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
      this.ffmpeg = null;
    }
  }
}
