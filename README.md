# TWiST Sentinel

Real-time podcast fact-checker for TWiST.

<!-- TODO: add dashboard screenshot -->

## What It Does

Sentinel transcribes live podcast audio in real time, detects checkable claims, retrieves evidence from the TWiST archive and live web search, and renders structured verdict cards with citations. It uses a single fact-checking agent, The Docket, to produce grounding-first verdicts. Cross-episode memory covers 127 TWiST episodes and 3,956 searchable chunks.

## Quick Start: Local

Prerequisites:

- Node.js 20+
- `ffmpeg`
- `yt-dlp`
- BlackHole 2ch for Mac system audio
- API keys: Deepgram, Anthropic, Tavily

Install and configure:

```bash
npm ci
cp .env.example .env
# Fill in DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, and TAVILY_API_KEY
```

Verify local Mac audio:

```bash
npm run preflight:audio
```

Start Sentinel:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Quick Start: Hosted (Railway)

Deploy with the included `Dockerfile` on Railway or another Docker-capable host.

Required environment variables:

- `DEEPGRAM_API_KEY`
- `ANTHROPIC_API_KEY` or `CLOUD_API_KEY`
- `TAVILY_API_KEY`
- `EMBED_PROVIDER=openai` for hosted deployments, or `ollama` for local embeddings
- `OPENAI_API_KEY` when `EMBED_PROVIDER=openai`
- `SENTINEL_ACCESS_TOKEN` for hosted bearer-token access

Run the hosted/server preflight in the target environment:

```bash
npm run preflight:hosted
```

Notes:

- YouTube streams may be blocked from datacenter IPs. If Railway gets a YouTube bot-block error, use local Mac system audio or a local relay.
- System audio capture uses macOS AVFoundation and requires a local Mac. It does not work on Linux hosts.

## Modes

### YouTube Stream

Open the dashboard, select `YouTube`, paste a YouTube URL, and start the stream.

API equivalent:

```bash
curl -X POST http://localhost:3000/api/session/start \
  -H "Content-Type: application/json" \
  -d '{"mode":"youtube","url":"YOUTUBE_URL_HERE"}'
```

### System Audio (Zoom)

Use this for Zoom/private meetings or any audio playing on a local Mac. Install BlackHole 2ch, route audio through a Multi-Output Device, grant microphone permission to the terminal app, then select `System Audio` in the dashboard.

Full setup: [Production Runbook](docs/PRODUCTION_RUNBOOK.md).

## Architecture

```text
Deepgram Nova-3
  -> Claim Classifier (Haiku)
  -> Gate Stack
  -> Parallel Retrieval (LanceDB + Tavily)
  -> The Docket (Haiku, tool_use)
  -> Dashboard
```

Sentinel is a single-agent fact-checker. There is no comedy persona, cynic persona, or entertainment layer.

## The Docket

The Docket emits structured verdict cards:

- `TRUE`
- `FALSE`
- `MISLEADING`
- `PARTIAL`
- `UNVERIFIABLE`

The Docket writes grounding before the verdict, so each card starts from what the retrieved evidence actually supports. Citations are tiered by source quality, and rendered URLs must come from retrieval results. If evidence is insufficient, Sentinel suppresses or marks the card `UNVERIFIABLE`; silence is preferred over fabrication.

## Dashboard

The dashboard is built for live production use:

- Scrollable transcript pane, roughly 65% of the screen.
- Docket sidebar, roughly 35% of the screen.
- Speaker labels from Deepgram diarization and operator mappings.
- Claim highlights that link transcript segments to verdict cards.
- Verdict pills for fast scanning.
- Citation rows with source tiers and copyable URLs.
- Actionable session errors with copyable diagnostics.

## Cross-Episode Memory

The local LanceDB archive contains 127 TWiST episodes and 3,956 searchable chunks. Local embeddings use EmbeddingGemma 308M through Ollama. Hosted deployments can use OpenAI `text-embedding-3-small`; vectors are not interchangeable, so changing embedding providers requires re-embedding the corpus.

## API Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/status` | `GET` | Return server status canary. |
| `/api/session/start` | `POST` | Start a YouTube or system-audio session. |
| `/api/session/stop` | `POST` | Stop the active session. |
| `/api/session/status` | `GET` | Return session state, mode, uptime, speaker map, last error, and Deepgram health. |
| `/api/queue/stats` | `GET` | Return claim retrieval/synthesis queue stats. |
| `/api/classifier/stats` | `GET` | Return classifier throughput, latency, and backpressure stats. |
| `/api/commit-episode` | `POST` | Commit provisional episode chunks. |
| `/api/dossier/load` | `POST` | Load a guest dossier. |

Session states are `idle`, `connecting`, `live`, and `error`. Deepgram health broadcasts as `connected`, `reconnecting`, or `disconnected`; reconnects use eight jittered backoff attempts before surfacing a terminal session error.

Hosted deployments with `SENTINEL_ACCESS_TOKEN` require:

```text
Authorization: Bearer <token>
```

## Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTP/WebSocket port. Defaults to `3000`. |
| `DEEPGRAM_API_KEY` | Yes | Nova-3 live transcription. |
| `ANTHROPIC_API_KEY` | Yes | Claim classifier and The Docket. |
| `CLOUD_API_KEY` | No | Fallback alias when `ANTHROPIC_API_KEY` is unset. |
| `TAVILY_API_KEY` | Yes for production | Live web retrieval. |
| `EMBED_PROVIDER` | No | `ollama` for local, `openai` for hosted. |
| `OPENAI_API_KEY` | When `EMBED_PROVIDER=openai` | OpenAI embeddings. |
| `OLLAMA_BASE_URL` | Local only | Ollama endpoint. Defaults to `http://localhost:11434`. |
| `OLLAMA_MODEL_TROLLS` | Local fallback only | Historical name for classifier fallback model. |
| `GROQ_API_KEY` | No | Optional classifier fallback. |
| `SENTINEL_ACCESS_TOKEN` | Hosted recommended | Shared bearer token for hosted access. Must be at least 24 characters if set. |
| `AUDIO_DEVICE` | No | Override system-audio device name. Defaults to `BlackHole 2ch`. |
| `CLAIM_CONFIDENCE_THRESHOLD` | No | Classifier confidence floor. Defaults to `0.7`. |
| `CLASSIFIER_MAX_CONCURRENCY` | No | Concurrent classifier calls. |
| `CLASSIFIER_MAX_PENDING` | No | Pending classifier queue size. |
| `CLAIM_QUEUE_MAX_PENDING` | No | Pending claim queue size. |

## Preflight Scripts

Local Mac system audio:

```bash
npm run preflight:audio
```

Checks `ffmpeg`, `yt-dlp`, AVFoundation device listing, and BlackHole 2ch detection. Does not start Sentinel.

Hosted/server:

```bash
npm run preflight:hosted
```

Checks required environment variables, `ffmpeg`, `yt-dlp`, and prints whether the host is Darwin or Linux.

## Operator Docs

- [Production Runbook](docs/PRODUCTION_RUNBOOK.md)
- [Monday Live Checklist](docs/MONDAY_LIVE_CHECKLIST.md)

## Built By

[@SkunkWorks0x](https://x.com/SkunkWorks0x)

MIT License
