# Monday Live Checklist

15-minute pre-show run. Stop on the first failed required check and switch to fallback if the fix is not obvious.

## T-15: Environment

Run:

```bash
cd /Users/imani/twistroll
npm run preflight:hosted
```

Confirm:

- `DEEPGRAM_API_KEY` present.
- `ANTHROPIC_API_KEY` or `CLOUD_API_KEY` present.
- `TAVILY_API_KEY` present.
- `ffmpeg` present.
- `yt-dlp` present.
- OS is printed.

## T-12: Local Audio

Run on Oliver's Mac:

```bash
npm run preflight:audio
```

Confirm:

- `ffmpeg` present.
- `yt-dlp` present.
- AVFoundation device list prints.
- `BlackHole 2ch` detected.

If BlackHole is missing:

```bash
brew install --cask blackhole-2ch
reboot
```

If there is no time to reboot, use YouTube/replay fallback.

## T-10: Audio Routing

In `Audio MIDI Setup`:

- Multi-Output Device exists.
- Built-in output/headphones checked.
- `BlackHole 2ch` checked.
- macOS output is routed to the Multi-Output Device.
- Zoom output is routed to the same path.

In `System Settings`:

- Microphone permission enabled for the terminal app running Sentinel.

## T-8: Start Sentinel

Run:

```bash
./start.sh
```

Open:

```text
http://localhost:3000
```

Confirm:

- Dashboard loads.
- Mode toggle visible.
- Status connected.
- No auth overlay unless hosted token is expected.

## T-6: Transcript Test

For system audio:

1. Select `System Audio`.
2. Click `Start Capture`.
3. Play a short audio clip or Zoom test audio.
4. Confirm transcript appears.

For YouTube:

1. Select `YouTube`.
2. Paste the stream URL.
3. Click `Start Stream`.
4. Confirm transcript appears.

## T-5: API And Retrieval Smoke

Only run these if paid API calls are acceptable:

```bash
npx tsx scripts/test-classifier.ts
npx tsx scripts/test-tavily-query.ts
```

Confirm:

- Deepgram session can connect through the dashboard.
- Anthropic classifier test passes.
- Tavily query test returns results.

## T-4: LanceDB Warmup

Watch `./start.sh` / server logs for:

```text
[LANCEDB] Warmup complete
```

If warmup fails, cards may still work but the first retrieval can be slow. Keep the server running and avoid restarting unless needed.

## T-3: WebSocket

Confirm browser status pill shows connected/live.

If disconnected:

```bash
curl http://localhost:3000/api/status
```

If hosted with auth:

```bash
curl "$SENTINEL_URL/api/status" \
  -H "Authorization: Bearer $SENTINEL_ACCESS_TOKEN"
```

## T-2: Five-Minute Soak

Let audio run for five minutes.

Confirm:

- Transcript continues updating.
- Claim cards appear for checkable claims.
- No repeated reconnect loops.
- No persistent `Deepgram disconnected`.
- Errors, if any, show actionable messages.

## Fallbacks

### If YouTube Blocks Railway

Use local Mac system audio instead.

1. Open the YouTube stream in a browser on Oliver's Mac.
2. Route Mac output through the Multi-Output Device with BlackHole.
3. Use dashboard `System Audio` mode.

Do not spend more than two minutes retrying Railway from the same IP after a YouTube bot-block error.

### If Zoom Audio Fails

Fallback options in order:

1. Use a browser/YouTube source if available.
2. Switch Zoom output to built-in speakers/headphones plus BlackHole Multi-Output Device.
3. Restart Sentinel after changing macOS microphone permission.
4. If BlackHole is not available and reboot is not possible, run YouTube/replay mode instead.

