# TWiST Sentinel

Real-time AI fact-checking for live podcasts. Built for [This Week in Startups](https://www.youtube.com/@thisweekin).

Sentinel listens to a live podcast stream, detects checkable claims, retrieves evidence from the TWiST archive and live web search, and renders structured fact-check cards in a browser dashboard. In recent smoke tests, cards appeared roughly 5–7 seconds after the claim was spoken.

> *"A real time podcast fact checker."*
> — Jason Calacanis describing what he wants built, TWiST, May 11, 2026

<!-- TODO: Add hero screenshot -->
<!-- ![TWiST Sentinel Dashboard](docs/assets/sentinel-dashboard-hero.png) -->

---

## 127 episodes · 3,956 chunks · 5–7s claim-to-card · single agent

---

## Silence Over Fabrication

Sentinel's core design principle: if the evidence doesn't support a verdict, say nothing. Every rendered card must include at least one validated citation URL. Cards without citations are suppressed. URLs not present in retrieval results are never rendered. The gate stack, post-processing pipeline, and UNVERIFIABLE render policy all enforce this — the system would rather show fewer cards than risk a single fabricated source.

This is not a design choice made for safety theater. It is the fundamental difference between a fact-checker that earns trust over a 90-minute episode and one that doesn't.

---

## What a Card Contains

Each fact-check card renders four fields:

**Grounding** — one sentence stating what the retrieved evidence says about the specific assertion, written before the verdict is assigned. Forces the model to confront what the evidence actually says rather than pattern-matching on topic similarity. 40-word max.

**Verdict** — TRUE, FALSE, MISLEADING, PARTIAL, or UNVERIFIABLE. UNVERIFIABLE means retrieval found no source that confirms the specific assertion — it does not mean the claim is false.

**Explanation** — the verdict rationale in 28 words or fewer, with inline citation references.

**Citations** — validated source URLs only, organized by credibility tier. Tier 1: SEC filings, Bloomberg, Reuters, company IR, official government sources, and the TWiST archive. Tier 2: Wikipedia, Crunchbase, PitchBook, FT, The Information. Tier 3: everything else not blocked. Tier 4 (blocked, never rendered): Reddit, Quora, Medium blogs, SEO content farms.

<!-- TODO: Add card detail screenshot -->
<!-- ![Fact-check card detail](docs/assets/sentinel-card-detail.png) -->

---

## How a Claim Becomes a Card

A guest says *"OpenAI and Microsoft have altered their ongoing partnership."* Here's what happens in the next 6 seconds:

1. **Deepgram Nova-3** transcribes the audio stream in real time with speaker diarization.
2. **The claim classifier** (Haiku 4.5) examines a sliding 3-segment window, resolves pronouns, and extracts the checkable assertion with a primary entity and claim type. Confidence must exceed 0.7 to proceed.
3. **The 7-layer gate stack** checks: is this entity on the sponsor blocklist? Has this entity been checked in the last 90 seconds with a similar claim fingerprint? Is this a duplicate already in the queue? If any gate fires, the claim is silently dropped.
4. **Parallel retrieval** fans out to LanceDB (127 TWiST episodes, 3,956 searchable chunks) and Tavily (live web search). Results are merged, deduplicated, and filtered by credibility tier. Capped at 6 sources, roughly 1,400 tokens.
5. **The Docket** (Haiku 4.5 via tool_use) receives the claim, the transcript context, and the retrieved evidence. It writes the grounding field first — stating what the evidence says about this specific assertion — then commits to a verdict, writes the explanation, and attaches citations by reference number.
6. **Post-processing** validates the output against a Zod schema, cross-checks that every cited reference number maps to a real retrieval result, enforces word limits, scans for anti-pattern language, and suppresses UNVERIFIABLE cards with zero citations.
7. **The card appears** on the dashboard via WebSocket.

---

## Cross-Episode Memory

LanceDB stores 127 TWiST episodes (Ep 2007 through Ep 2285) as 3,956 searchable chunks embedded with EmbeddingGemma 308M. When a guest references something Jason discussed three months ago, Sentinel can surface it.

Provenance-separated: primary transcript evidence and derived verdict summaries are queried independently and labeled in the Docket's context window. Derived verdicts can appear as secondary show memory but are never treated as primary evidence for TRUE, FALSE, or MISLEADING verdicts.

---

## Design Choices

**Structured verdicts, not free-text opinions.** Every card commits to one of five verdict types. This makes the output auditable and consistent across a 90-minute episode.

**Grounding-first architecture.** The Docket must state what the evidence says before assigning a verdict. This attacks the dominant failure mode in retrieval-augmented fact-checking: retrieving a topically related source that doesn't actually support the specific claim.

**Tiered citation pipeline.** Not all sources are equal. SEC filings outrank Wikipedia. Wikipedia outranks blog posts. Blog posts from SEO farms are blocked entirely. The tier is visible on every citation.

**Claim fingerprint cooldown.** Entity-only cooldown suppresses distinct claims about the same company. Sentinel uses token-level Jaccard similarity plus predicate-bucket matching to distinguish "Microsoft is behind in AI" from "Microsoft has unbeatable enterprise distribution" even when both mention Microsoft within 90 seconds.

**Conservative by default.** The gate stack, post-processing pipeline, and render policy are all tuned to suppress rather than fabricate. A quiet sidebar is better than a wrong one.

---

## Latest Smoke Test

Fresh run against TWiST E2281 ("China Kills Meta/Manus Deal"), May 2026:

- 6 cards rendered (3 TRUE, 1 PARTIAL, 1 MISLEADING, 1 UNVERIFIABLE with citations)
- 13 cited URLs — all validated against tier-1/2 sources (Reuters, Ars Technica, TechCrunch, FT, Bloomberg) plus 2 LanceDB archive citations
- 0 hallucinated URLs
- 0 crashes
- 1 Zod schema overshoot recovered via corrective retry

This is a smoke test, not a benchmark. A proper eval set with gold-labeled claims is on the roadmap.

---

## Quick Start

```bash
git clone https://github.com/SkunkWorks0x/twistroll.git
cd twistroll
cp .env.example .env   # Add your API keys (see below)
./start.sh             # Pre-flight checks + launch
```

`start.sh` verifies every dependency before booting: Node.js, ffmpeg, yt-dlp, Ollama (daemon + models), and API keys. If anything is missing, it tells you exactly what and exits cleanly.

> **Note:** The repo is named `twistroll` for historical reasons — TWiSTroll v1 was the predecessor project. The current product is TWiST Sentinel.

### Requirements

**CLI tools** (must be on PATH):
- Node.js >= 18
- ffmpeg
- yt-dlp
- Ollama (`ollama serve`)

**Ollama models** (pull before first run):
```bash
ollama pull embeddinggemma
ollama pull qwen2.5:7b
```

**API keys** (in `.env`):

| Key | Required | Purpose |
|-----|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Claim classifier + Docket verdicts (Haiku 4.5) |
| `DEEPGRAM_API_KEY` | Yes | Live audio transcription (Nova-3) |
| `TAVILY_API_KEY` | Recommended | Live web retrieval. Without it, Sentinel checks the TWiST archive only — most claims about current events will go UNVERIFIABLE. |
| `GROQ_API_KEY` | No | Classifier fallback chain — skipped without it |

### Start a Session

With the server running at http://localhost:3000:

```bash
curl -X POST http://localhost:3000/api/session/start \
  -H "Content-Type: application/json" \
  -d '{"source": "YOUTUBE_URL_HERE", "mode": "stream"}'
```

### Estimated Cost

Roughly $2–4 per 90-minute episode at current Haiku 4.5 and Deepgram pricing. Dominated by Deepgram streaming and Haiku API calls. Tavily adds approximately $0.50–1.00 depending on claim density. Ollama embeddings are free (local).

---

## Current Limitations

- **YouTube stream input only.** Zoom/system-audio adapter (via BlackHole) is planned but not yet packaged.
- **Localhost only.** No hosted deployment, no authentication layer. See Security below.
- **Archive coverage is partial.** 127 of ~279 episodes ingested. 152 gaps in the Ep 2007–2285 range.
- **Speaker diarization resolves to SPEAKER 0 / SPEAKER 1**, not names. Functional but not polished.
- **UNVERIFIABLE does not mean false.** It means no retrieved source confirms the specific assertion.
- **Latency varies.** 5–7 seconds observed in smoke tests; actual latency depends on Deepgram, Tavily, and Haiku response times.

---

## Failure Behavior

Sentinel is conservative by design:

- If classifier JSON is malformed, the claim is retried once or suppressed.
- If citations cannot be validated against retrieval results, the card is suppressed.
- If Tavily is unavailable, Sentinel falls back to archive-only retrieval.
- If Ollama is down, LanceDB queries fail gracefully and the classifier falls through to cloud-only mode.
- If no source verifies the exact assertion, the card is marked UNVERIFIABLE. If that UNVERIFIABLE card also has zero citations, it is suppressed entirely.

---

## Security

Sentinel is designed for local operation. The `/api/session/start` endpoint accepts a URL and has no authentication. Do not expose it to the public internet without adding auth and URL allowlisting.

---

## Roadmap

- [ ] Zoom/BlackHole audio adapter
- [ ] LanceDB backfill (152 remaining episodes)
- [ ] Hosted replay page (closes the "must clone to see it" gap)
- [ ] Eval set with gold-labeled claims
- [ ] Speaker name resolution from dossier
- [ ] Session-start authentication

---

## Built By

[@SkunkWorks0x](https://x.com/SkunkWorks0x) — solo founder building AI agent infrastructure. TWiST Sentinel was built against Jason's May 11 spec change to single-agent fact-checking and shipped as a solo effort on a MacBook.

MIT License
