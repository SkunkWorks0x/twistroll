# TWiST Sentinel

**Real-time AI fact-checker + cynic for live podcasts.**

Two AI personas watch your show and surface verified facts, counterarguments, and follow-up questions — in real time, with citations from Reuters, Bloomberg, and TechCrunch.

Built for the [TWiST bounty](https://x.com/twistartups) announced live on air by Jason Calacanis, April 27, 2026. Two personas, scrollable transcript, runs on any stream or Zoom. Jason's spec, built to Jason's spec.

---

## What it does

Sentinel listens to a live podcast stream, detects verifiable claims in real time, and produces structured fact-check cards with:

- **Verdicts** — TRUE, FALSE, MISLEADING, PARTIAL, or UNVERIFIABLE on every claim
- **Citations** — sourced from Reuters, Bloomberg, TechCrunch, SEC filings, and 127 TWiST episodes in memory
- **Counterpoints** — precedent-driven "the other side of it" on every card
- **Follow-up questions** — the next question the host should ask
- **Scrollable transcript** — the full conversation with highlighted claim segments

The host scrolls up, sees what was said, sees the fact-check, sees the counterargument, sees the follow-up question. That's the product.

---

## The two personas

| Persona | Role | Voice |
|---------|------|-------|
| **The Docket** | Fact-checker | Clinical precision. Verdict + explanation + citations + follow-up question. "The record is the record." |
| **The Pattern Recognizer** | Cynic | Calm senior partner. Precedent-driven counterarguments. "The precedent here is..." |

No comedy. No sound effects. No entertainment framing. Jason said "you don't have to try to get the jokes — that's my job." These two personas do the work Jason described: real-time fact checking and real-time cynic.

---

## What the demo shows

8 minutes uncut against TWiST E2281 (China Kills Meta/Manus Deal). No narration, no editing. What you see is what you get.

Cards that fired during the demo:

- **FALSE** — "Google owns DeepSeek" → debunked with Reuters and TechCrunch, naming the actual owner
- **MISLEADING** — "Apple and Microsoft are the two furthest behind in AI" → corrected with three sources
- **TRUE** — "Manus founders relocated to Singapore in 2025" → confirmed with two Reuters sources
- **PARTIAL** — Microsoft $900B revenue claim → fact-checked with Bloomberg and The Information
- **TRUE** — "OpenAI models on Bedrock in coming weeks" → confirmed with Ars Technica

80% citation rate. Zero hallucinated URLs. Zero crashes.

---

## Cross-episode memory

127 TWiST episodes (Ep 2007 through Ep 2285) indexed in LanceDB. When a guest makes a claim, Sentinel cross-references what was said on prior shows.

In the demo, a claim about Microsoft's OpenAI stake surfaced a TWiST archive citation from Ep 2201 (October 2025). The card rendered with "— show archive" label, distinguishing internal memory from external sources.

This is the feature Jason described: "we can feed in our full docket and it can say, hey, this guest posted about this on X that we already have in the docket."

---

## Architecture
Audio source (YouTube via yt-dlp, or Zoom via BlackHole)
→ Deepgram Nova-3 streaming (diarization, smart_format)
→ Sliding 3-segment window
→ Claim Classifier (Claude Haiku 4.5, structured extraction)
→ Gate chain: empty-entity → sponsor → weak-entity → cooldown → dedup
→ Parallel Retrieval: LanceDB + Tavily (relationship-first queries)
→ Parallel Synthesis: Docket (tool_use JSON) + Pattern Recognizer (text)
→ Post-processing: Zod validation, citation cross-check, word limits
→ WebSocket → Browser dashboard

Typical claim-to-card latency: 5-7 seconds.

---

## Dashboard

The browser dashboard at `localhost:3000` is the primary interface:

- **Left (65%)** — Scrollable transcript with speaker labels and claim highlights
- **Right (35%)** — Pinned sidebar with fact-check cards, auto-collapsing older cards
- **Click-to-expand** — Collapsed cards expand to show full verdict, citations, and counterpoint
- **Bidirectional sync** — Click a card to highlight the transcript segment, click a segment to scroll to the card

Design language: Bloomberg terminal meets teleprompter. JetBrains Mono for system chrome, Source Serif 4 for human content. Engineered for 2-3 second glance reads under studio lighting.

---

## Quick start

```bash
git clone https://github.com/SkunkWorks0x/twistroll.git
cd twistroll
npm install
cp .env.example .env
# Add your Anthropic API key and Tavily API key

# Pull the embedding model
ollama pull embeddinggemma

# Start
npm run dev
# Open http://localhost:3000
```

Start a session:
```bash
curl -X POST http://localhost:3000/api/session/start \
  -H "Content-Type: application/json" \
  -d '{"source": "https://youtube.com/watch?v=YOUR_VIDEO_ID"}'
```

No configuration screen, no guest names to type in, no setup wizard. URL in, facts out.

---

## LLM stack

| Component | Model | Role |
|-----------|-------|------|
| Claim Classifier | Claude Haiku 4.5 | Structured claim extraction from transcript |
| The Docket | Claude Haiku 4.5 | Fact-check verdict + citations via tool_use |
| The Pattern Recognizer | Claude Haiku 4.5 | Precedent-driven counterargument |
| Fallback classifier | Groq llama-3.3-70b | Cloud fallback |
| Last-resort classifier | Ollama qwen2.5:7b | Local fallback — pipeline never dies |
| Embeddings | EmbeddingGemma 308M | LanceDB vector search |

---

## Source credibility

Citations are tier-filtered before rendering:

| Tier | Sources | Treatment |
|------|---------|-----------|
| 1 (Primary) | SEC, BLS, FRED, company IR, Reuters, Bloomberg, NYT, WSJ, TechCrunch, AP | Full confidence |
| 2 (Credible) | Wikipedia, Crunchbase, PitchBook, SaaStr, FT, Economist, Ars Technica | Normal confidence |
| 3 (Secondary) | Everything else not blocked | "Unverified source" flag |
| 4 (Blocked) | Reddit, Quora, Medium blogs, SEO farms | Never rendered |

Hard rule: no URL = no citation card. Silence over fabrication.

---

## System requirements

- macOS with Apple Silicon (M1/M2/M3/M4/M5), 32GB RAM recommended
- Node.js 20+
- Ollama (for embeddings and local fallback)
- Anthropic API key
- Tavily API key

---

## What's next

Built and shipping now. If this earns the bounty, here's where it goes:

- **Zoom mode** — BlackHole audio capture for private calls
- **Per-guest social context** — pull guest's recent X posts and prior interviews into memory
- **Host contradiction card** — surface when the host contradicts their own prior statements
- **Laughter detection** — audio-aware feature for the broadcast experience

---

## License

MIT — do whatever you want with it.

---

Built by [@SkunkWorks0x](https://x.com/SkunkWorks0x)

*Built for the show. Ready for air.*
