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
import type { TranscriptSegment } from '../shared/types.js';

export type SessionMode = 'stream' | 'system-audio';

export interface SessionConfig {
  mode: SessionMode;
  source: string;
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
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECTS_PER_60S = 3;
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
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private reconnectTimes: number[] = [];
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
    this.reconnectTimes = [];
    this.audioBuffer = [];

    await this.connectDeepgram();
    this.startAudioPipeline();
    console.log(`[deepgram] session started: mode=${config.mode}, source="${config.source}"`);
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

  // ─── Deepgram WebSocket ────────────────────────────────────────────────

  private async connectDeepgram(): Promise<void> {
    const queryString = new URLSearchParams(DG_QUERY_PARAMS).toString();
    const url = `${DG_WS_URL}?${queryString}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.terminate();
          reject(new Error(`Deepgram WS connect timeout (${CONNECT_TIMEOUT_MS}ms)`));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timeout);
        console.log('[deepgram] WS connected');
        this.startKeepAlive();
        this.emit('connected');
        resolve();
      });

      ws.on('message', (data) => this.handleMessage(data));

      ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        console.warn(`[deepgram] WS closed: code=${code}, reason="${reason.toString() || '(none)'}"`);
        this.stopKeepAlive();
        this.emit('disconnected');
        if (!this.intentionalStop && this.active) {
          this.attemptReconnect();
        }
      });

      ws.on('error', (err) => {
        console.error(`[deepgram] WS error: ${err.message}`);
        this.emit('error', err);
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

    const cutoff = Date.now() - 60000;
    this.reconnectTimes = this.reconnectTimes.filter((t) => t > cutoff);

    if (this.reconnectTimes.length >= MAX_RECONNECTS_PER_60S) {
      const err = new Error(
        `Deepgram WS reconnect failed: ${MAX_RECONNECTS_PER_60S} retries within 60s — giving up`
      );
      console.error(`[deepgram] CRITICAL: ${err.message}`);
      this.emit('error', err);
      this.reconnecting = false;
      this.active = false;
      this.killAudioPipeline();
      return;
    }

    const attempt = this.reconnectTimes.length + 1;
    this.reconnectTimes.push(Date.now());
    console.warn(`[deepgram] reconnect attempt ${attempt}/${MAX_RECONNECTS_PER_60S} in ${RECONNECT_DELAY_MS}ms`);
    this.emit('reconnecting', { attempt });

    setTimeout(async () => {
      try {
        await this.connectDeepgram();
        this.reconnecting = false;
        // Audio pipeline keeps running through the gap; buffered chunks drain
        // on the next ffmpeg stdout 'data' event.
      } catch (err) {
        this.reconnecting = false;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[deepgram] reconnect attempt ${attempt} failed: ${msg}`);
        // The 'close' handler on the failed-to-open WS will trigger another
        // attemptReconnect() if active && !intentionalStop.
      }
    }, RECONNECT_DELAY_MS);
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

    let directUrl = '';
    ytdlp.stdout.on('data', (chunk) => {
      directUrl += chunk.toString();
    });

    ytdlp.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.warn(`[yt-dlp] ${msg}`);
    });

    ytdlp.on('close', (code) => {
      this.ytdlp = null;
      if (!this.active) return;
      if (code !== 0) {
        const err = new Error(`yt-dlp exited with code ${code}`);
        console.error(`[deepgram] ${err.message}`);
        this.emit('error', err);
        return;
      }
      const cleanUrl = directUrl.trim().split('\n')[0];
      if (!cleanUrl) {
        this.emit('error', new Error('yt-dlp returned no audio URL'));
        return;
      }
      console.log('[deepgram] yt-dlp resolved direct audio URL');
      this.spawnFfmpegFromUrl(cleanUrl);
    });
  }

  private spawnFfmpegFromUrl(url: string): void {
    const ffmpeg = spawn('ffmpeg', [
      '-i', url,
      '-f', 's16le',
      '-ar', '16000',
      '-ac', '1',
      '-acodec', 'pcm_s16le',
      '-loglevel', 'warning',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
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
        console.error(`[deepgram] system-audio device resolution failed: ${err.message}`);
        this.emit('error', err);
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
        const audioSection = stderr.split('AVFoundation audio devices:')[1] || '';
        const match = audioSection.split('\n').find((line) => line.includes(name));
        if (!match) {
          return reject(new Error(`Audio device "${name}" not found in avfoundation list`));
        }
        const m = match.match(/\[(\d+)\]\s/);
        if (!m) {
          return reject(new Error(`Could not parse device index from line: "${match.trim()}"`));
        }
        resolve(parseInt(m[1], 10));
      });
    });
  }

  private attachFfmpegStreams(ffmpeg: ChildProcess): void {
    if (!ffmpeg.stdout) {
      this.emit('error', new Error('ffmpeg stdout pipe missing'));
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

    if (ffmpeg.stderr) {
      ffmpeg.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) console.warn(`[ffmpeg] ${msg}`);
      });
    }

    ffmpeg.on('close', (code) => {
      this.ffmpeg = null;
      if (this.active && !this.intentionalStop && code !== 0) {
        const err = new Error(`ffmpeg exited unexpectedly with code ${code}`);
        console.error(`[deepgram] ${err.message}`);
        this.emit('error', err);
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
