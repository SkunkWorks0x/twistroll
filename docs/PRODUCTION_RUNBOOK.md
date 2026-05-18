# TWiST Sentinel Production Runbook

Operator target: Oliver/Jason can start Sentinel, confirm audio/transcript/card flow, and identify actionable failures without reading server code.

## Paths

### Local Mac System Audio

Use this for Zoom/private meetings or any audio playing on Oliver's Mac.

Required:

- macOS
- Node.js 18+
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

Check:

```bash
test -n "$DEEPGRAM_API_KEY" && echo "DEEPGRAM_API_KEY present"
npm run preflight:hosted
```

If the key is present and failures persist, rotate/test the key in Deepgram and restart Sentinel.

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
- Transcript lines appear within a few seconds of audio.
- Claim cards appear in the Docket sidebar after checkable claims.
- Errors show actionable messages, not generic failure text.
- `Copy diagnostic` is available on session errors.

