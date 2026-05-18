# TWiST Sentinel Production Runbook

Operator target: Oliver/Jason can start Sentinel, confirm audio/transcript/card flow, and identify actionable failures without reading server code.

## Paths

### Local Mac System Audio

Use this for Zoom/private meetings or any audio playing on Oliver's Mac.

Required:

- macOS
- Node.js 20+
- `ffmpeg`
- `yt-dlp`
- BlackHole 2ch
- Deepgram, Anthropic, and Tavily keys in `.env`

Preflight:

```bash
npm run preflight:audio
```

Start:

```bash
./start.sh
```

Open:

```text
http://localhost:3000
```

In the dashboard:

1. Select `System Audio`.
2. Click `Start Capture`.
3. Confirm status is connected.
4. Play meeting/audio and watch transcript appear.

Device resolution order for system audio:

1. `source` in the `/api/session/start` request.
2. `AUDIO_DEVICE` environment variable.
3. `BlackHole 2ch`.

The audio device is resolved when the session starts. Deepgram reconnects keep the existing audio pipeline; changing `AUDIO_DEVICE` or macOS routing requires stopping and starting the session.

### YouTube Hosted Or Replay

Use this for public YouTube streams or hosted Railway replay.

Local hosted-style preflight:

```bash
npm run preflight:hosted
```

Start locally:

```bash
./start.sh
```

Start a YouTube session from the dashboard:

1. Select `YouTube`.
2. Paste a YouTube or `youtu.be` URL.
3. Click `Start Stream`.

Start by API:

```bash
curl -X POST http://localhost:3000/api/session/start \
  -H "Content-Type: application/json" \
  -d '{"mode":"youtube","url":"YOUTUBE_URL_HERE"}'
```

If `SENTINEL_ACCESS_TOKEN` is set:

```bash
curl -X POST "$SENTINEL_URL/api/session/start" \
  -H "Authorization: Bearer $SENTINEL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"youtube","url":"YOUTUBE_URL_HERE"}'
```

Hosted auth behavior:

- Static dashboard HTML is public.
- `/api/*` routes require `Authorization: Bearer <token>` when `SENTINEL_ACCESS_TOKEN` is set.
- WebSocket auth uses `?token=...` because browser WebSockets cannot set custom headers.
- `SENTINEL_ACCESS_TOKEN` must be at least 24 characters if set; shorter values refuse boot.

## API Routes

| Route | Method | Auth when token set | Purpose |
| --- | --- | --- | --- |
| `/api/status` | `GET` | Yes | Ollama/load-bearing status canary. |
| `/api/session/start` | `POST` | Yes | Start `youtube`, `stream`, or `system-audio` session. |
| `/api/session/stop` | `POST` | Yes | Stop the active session; waits for in-flight start. |
| `/api/session/status` | `GET` | Yes | Session state, active flag, speaker map, error, and Deepgram health. |
| `/api/queue/stats` | `GET` | Yes | Claim queue, backpressure, and retrieval breaker stats. |
| `/api/classifier/stats` | `GET` | Yes | Classifier throughput and queue stats. |
| `/api/commit-episode` | `POST` | Yes | Commit provisional episode chunks. |
| `/api/dossier/load` | `POST` | Yes | Load a guest dossier by name. |
| `/config` | `GET` | No | Minimal config/status panel. |

Session states:

- `idle`
- `connecting`
- `live`
- `error`

Deepgram health states shown during live sessions:

- `connected`
- `reconnecting` with attempt number
- `disconnected`

## BlackHole Setup

Install:

```bash
brew install --cask blackhole-2ch
```

Reboot after install. BlackHole often does not appear in AVFoundation/Audio MIDI Setup until after a reboot.

Audio MIDI Setup:

1. Open `Audio MIDI Setup`.
2. Click `+` in the lower-left.
3. Choose `Create Multi-Output Device`.
4. Check both:
   - Built-in output / headphones
   - BlackHole 2ch
5. Set system output to the Multi-Output Device.
6. For Zoom, route Zoom output to the Multi-Output Device or BlackHole path used in the rehearsal.

Microphone permission:

1. Open `System Settings`.
2. Go to `Privacy & Security` -> `Microphone`.
3. Enable the terminal app running Sentinel: Terminal, iTerm, VS Code, or Cursor.
4. Restart Sentinel after changing permission.

## Diagnostics

### YouTube Bot Block

Dashboard likely shows:

- `YOUTUBE_BOT_CHECK`
- `YOUTUBE_NOT_LIVE_OR_BLOCKED`
- `YOUTUBE_UNAVAILABLE_OR_BLOCKED`
- `YOUTUBE_HLS_FORBIDDEN`

Meaning: YouTube is blocking the server or the stream is unavailable.

Next steps:

```bash
yt-dlp -f bestaudio --get-url "YOUTUBE_URL_HERE"
```

If this fails on Railway/Linux but works on Oliver's Mac, switch to local Mac capture or replay. Do not burn show time retrying the same hosted IP.

### BlackHole Not Found

Dashboard likely shows:

- `AVFOUNDATION_DEVICE_NOT_FOUND`

Run:

```bash
npm run preflight:audio
```

If missing:

```bash
brew install --cask blackhole-2ch
reboot
```

Then confirm `BlackHole 2ch` appears in Audio MIDI Setup and rerun the preflight.

### ffmpeg Failure

Dashboard likely shows:

- `FFMPEG_EXIT_NONZERO`
- `YOUTUBE_HLS_FORBIDDEN`
- `AVFOUNDATION_PERMISSION_DENIED`

Check:

```bash
ffmpeg -version
npm run preflight:audio
```

For permission denial, grant microphone permission to the terminal app and restart Sentinel.

### Deepgram Disconnected

Dashboard likely shows:

- `DEEPGRAM_DISCONNECTED`

Deepgram reconnect behavior:

- Sentinel retries up to 8 times per incident.
- Backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s.
- Each delay has jitter.
- The live session bar shows `Reconnecting (attempt N)...` during reconnect.
- Reconnect does not re-resolve the system-audio device; it restores the Deepgram WebSocket while the audio pipeline continues.
- After all attempts fail, the session moves to `error` and releases the active session flag so a retry is possible.

Check:

```bash
test -n "$DEEPGRAM_API_KEY" && echo "DEEPGRAM_API_KEY present"
npm run preflight:hosted
```

If the key is present and failures persist, rotate/test the key in Deepgram and restart Sentinel.

### Unknown Session Error

Dashboard may show:

- `UNKNOWN_SESSION_ERROR`

Meaning: an error escaped a structured pipeline classifier.

Next steps:

1. Click `Copy diagnostic`.
2. Save the server log around the same timestamp.
3. Stop the session and retry once.
4. If it repeats, switch input mode or fallback path.

### Tavily Or Anthropic Rate Limit

Symptoms:

- Transcript appears but claim cards are delayed or absent.
- Server logs mention Tavily, Anthropic, rate limits, 429, timeout, or overloaded.

Check env:

```bash
npm run preflight:hosted
```

Check targeted smoke tests when safe:

```bash
npx tsx scripts/test-tavily-query.ts
npx tsx scripts/test-classifier.ts
```

These may call paid APIs.

## What Oliver Should See

- Dashboard loads at `http://localhost:3000` or hosted URL.
- Mode toggle is visible: `YouTube` / `System Audio`.
- Status pill shows connected/live.
- During a Deepgram reconnect, the live bar shows `Reconnecting (attempt N)...`.
- Transcript lines appear within a few seconds of audio.
- Claim cards appear in the Docket sidebar after checkable claims.
- Errors show actionable messages, not generic failure text.
- `Copy diagnostic` is available on session errors.

## Shutdown Behavior

On `SIGTERM` or `SIGINT`, Sentinel:

1. Stops the active Deepgram session if one is running.
2. Closes connected WebSocket clients.
3. Closes the WebSocket server and HTTP server.
4. Exits `0` after a clean drain.
5. Forces exit `1` if drain exceeds 10 seconds.

Unhandled promise rejections are logged and do not automatically exit the process.
