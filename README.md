# TWiST Sentinel

Real-time AI fact-checker for live podcasts. Built for [This Week in Startups](https://www.thisweekinstartups.com/).

**[Try it live →](https://twistroll-production-60f7.up.railway.app)**

## What it does

Listens to a live podcast stream, detects factual claims in real time, and verifies them against 127 archived TWiST episodes + live web sources. Every verdict comes with citations. No claim goes unchecked — silence over fabrication.

## Demo

<!-- TODO: Replace placeholder with a real screenshot or GIF. No image currently committed to repo. -->
![TWiST Sentinel live dashboard](docs/demo.png)

Live fact-checking against TWiST E2291 (Mercury Bank / Kled episode, May 20, 2026). Every card generated in real time from the YouTube audio stream.

## Features

- **Real-time claim detection** — Deepgram Nova-3 streaming → claim classifier → 7-layer gate stack → parallel retrieval → verdict synthesis. A few seconds end-to-end (typically 4–8s; classifier + retrieval + synthesis dominate).
- **Cross-episode memory** — 127 TWiST episodes (3,956 chunks) in LanceDB. The Docket references what Jason said months ago.
- **Evidence-locked customization** — Four voice modes (Producer / On-Air / Analyst / Cynic), length slider, strictness and density controls. Voice changes wording. Evidence stays locked.
- **Scrollable transcript** — 65% hero surface with speaker labels, claim highlights, and per-character typewriter text reveal.
- **Sponsor filtering** — Automatic suppression of sponsor read claims (Plaud, Grasshopper, etc.) via hybrid name match + phrase detection across the recent-segment window.
- **Entity resolution** — Topic-context tracking resolves pronouns ("the company," "their business") to named entities across conversation segments.
- **Citation discipline** — No URL = no card. Tiered citations (Tier 1: primary sources, Tier 2: secondary, Tier 3: tertiary). Hallucinated URLs trigger retry then fallback to UNVERIFIABLE.

## The Docket (sole agent)

| Field | Constraint |
|-------|-----------|
| Grounding | What evidence says about the specific assertion. 40 word max. ≥1 citation ref. |
| Verdict | TRUE · FALSE · MISLEADING · PARTIAL · UNVERIFIABLE |
| Explanation | 20–24 word target, 28 hard max. Inline [1][2] refs. |
| Citations | Tiered. No URL = no card. Silence over fabrication. |

## Architecture

```
Audio (YouTube / System Audio)
  → Deepgram Nova-3 streaming (diarize, smart_format, punctuate)
  → Claim Classifier (Haiku 4.5, structured extraction + topic-context resolution)
  → Gate stack (7 layers: empty-entity, sponsor, speaker, weak-entity, cooldown, dedup, concurrency)
  → Parallel retrieval: LanceDB (127 episodes) + Tavily
  → The Docket (Haiku 4.5, tool_use JSON: grounding → verdict → explanation → citations)
  → Post-processing (Zod validation, citation cross-check, word limits, anti-pattern scan)
  → WebSocket → Browser dashboard
```

## Quick start

### Hosted (zero install)

Visit [twistroll-production-60f7.up.railway.app](https://twistroll-production-60f7.up.railway.app) and hit **Try with Latest TWiST Episode**.

### Local (full pipeline)

```bash
git clone https://github.com/SkunkWorks0x/twistroll.git
cd twistroll
cp .env.example .env
# Fill in DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, TAVILY_API_KEY, OPENAI_API_KEY
./start.sh
```

Requires Node 18+ and API keys for Anthropic + Deepgram + Tavily + OpenAI in `.env` (see `.env.example`). The committed LanceDB corpus is embedded with OpenAI `text-embedding-3-small` (1536-dim), so `OPENAI_API_KEY` is required for retrieval to work. Set `EMBED_PROVIDER=ollama` and run a local Ollama daemon with `embeddinggemma` if you want to re-embed locally.

## Built by

**Imani** · [@SkunkWorks0x](https://x.com/SkunkWorks0x) · Solo founder

Built for Jason Calacanis's TWiST bounty — "A real time podcast fact checker."

## License

MIT
