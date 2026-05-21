# TWiST Sentinel

Real-time podcast fact-checker for TWiST.

## Production Surface

Sentinel is ready for live local demos using BlackHole 2ch system audio on macOS. The dashboard supports operator speaker assignment for `HOST`, `COHOST`, `GUEST 1`, `GUEST 2`, and `GUEST 3`; this keeps Jason, Alex, and multi-guest panels readable during recording.

The local retrieval archive is rebuilt for Ollama EmbeddingGemma 768-dim vectors and contains 3,956 chunks across 127 TWiST episodes. Entity alias normalization is wired before retrieval to correct common Deepgram proper-noun misses such as Wayve/Waabi variants.

## What It Does

Sentinel transcribes live podcast audio in real time, detects checkable claims, retrieves evidence from the TWiST archive and live web search, and renders structured verdict cards with citations. It uses a single fact-checking agent, The Docket, to produce grounding-first verdicts. Cross-episode memory covers 127 TWiST episodes and 3,956 searchable chunks.

## Key Features

- **Evidence-locked voice modes** — Four presentation styles (Producer / On-Air / Analyst / Cynic) change wording only. Verdicts, citations, retrieval, and post-processing stay fixed regardless of mode. Voice changes wording. Evidence stays locked.
- **Customization panel** — Mode, explanation length (20/28/40/80 words), source strictness (Tier 1 / Balanced / Broad), and claim density (Quiet / Normal / Aggro). All settings validate server-side.
- **TWiST Memory badges** — Cross-episode citations display a TWiST Memory badge showing which prior episode the evidence came from.
- **Classifier health pill** — Live status indicator (LIVE / DEGRADED / OFFLINE) with UNEVAL counter for claims that couldn't be classified.
- **Citation hover tooltips** — Hover any source chip to see the retrieval snippet and tier badge without expanding the card.
- **Speaker registry** — Attribution-aware speaker binding with host roster detection and manual pill override.
- **Sponsor gate** — Expanded blocklist with phrase-detection regex suppresses sponsor-mention claims automatically.
- **Gemini 3.5 Flash classifier** — Optional fast classifier behind `CLASSIFIER_PROVIDER=gemini` env flag. Measured latency comparable to Haiku (~1.4s) on full classifier workload; primary value is removing Anthropic credit dependency on the highest-volume pipeline call.
- **Demo replay** — "Try with Latest TWiST Episode" button feeds a cached real transcript (E2291, 674 segments) through the full pipeline. Cards are live-generated, not pre-rendered.

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

Demo recording path:

```bash
npm run preflight:audio
npm run dev
```

Then open the dashboard, select `System Audio`, start the session, and click speaker pills as needed to assign `HOST`, `COHOST`, and `GUEST 1-3`.

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

Full Zoom setup: [Zoom Setup](docs/zoom-setup.md).
General Mac runbook: [Production Runbook](docs/PRODUCTION_RUNBOOK.md).

## Architecture

```text
Deepgram Nova-3
  -> Claim Classifier (Haiku or Gemini 3.5 Flash)
  -> Gate Stack (7 layers including sponsor name + sponsor phrase detection)
  -> Parallel Retrieval (LanceDB 127 episodes + Tavily)
  -> The Docket (Haiku, tool_use, evidence-locked voice modes)
  -> Post-processing (Zod, citation cross-check, anti-pattern scan)
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
- Clickable speaker pills for live `HOST`, `COHOST`, and `GUEST 1-3` assignment.
- Claim highlights that link transcript segments to verdict cards.
- Verdict pills for fast scanning.
- Citation rows with source tiers and copyable URLs.
- Actionable session errors with copyable diagnostics.
- Customization panel: mode, length, strictness, density controls.
- Classifier health pill with live/degraded/offline status.
- TWiST Memory badges on cross-episode citations.
- Citation hover tooltips with retrieval snippets.
- Grounding line (italic, muted) below verdict for evidence context.
- Auto-collapse older cards with click-to-expand.
- Auto-follow pause with "N new claims" resume banner.
- Live stats bar: segments processed, claims heard, cards rendered, claims suppressed, and unevaluated count.

## Cross-Episode Memory

The local LanceDB archive contains 127 TWiST episodes and 3,956 searchable chunks. Local embeddings use EmbeddingGemma 308M through Ollama. Hosted deployments can use OpenAI `text-embedding-3-small`; vectors are not interchangeable, so changing embedding providers requires re-embedding the corpus.

## API Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/status` | `GET` | Return server status canary. |
| `/api/session/start` | `POST` | Start a YouTube or system-audio session. |
| `/api/session/stop` | `POST` | Stop the active session. |
| `/api/session/status` | `GET` | Return session state, mode, uptime, speaker map, last error, and Deepgram health. |
| `/api/session/speakers` | `POST` | Update operator speaker role assignments for the active session. |
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
| `CLASSIFIER_PROVIDER` | No | Set to `gemini` to route the classifier through Gemini 3.5 Flash. Unset / any other value → Haiku. |
| `GEMINI_API_KEY` | When `CLASSIFIER_PROVIDER=gemini` | Gemini 3.5 Flash classifier. |
| `DEMO_FORCE_REPLAY` | No | Set to `1` to force demo replay mode on the quick-start button. |
| `DEMO_YOUTUBE_URL` | No | YouTube URL for the demo quick-start button fallback. |

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
- [Zoom Setup Guide](docs/zoom-setup.md)

## Built By

[@SkunkWorks0x](https://x.com/SkunkWorks0x)

MIT License
