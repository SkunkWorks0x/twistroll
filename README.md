# TWiSTroll

**The viewer-facing AI commentary layer for live podcasts.**

Four AI personas react to your show in real time, displayed as floating bubbles over the broadcast. Built as an OBS browser source — drag, drop, on air. Tested live against multiple TWiST episodes.

Built for the [March 27, 2026 TWiST bounty](https://x.com/TWiStartups). Released under MIT for any podcast to use.

![TWiSTroll Demo](https://github.com/SkunkWorks0x/twistroll/raw/main/demo/twistroll-demo.gif)

[**Watch the 7-minute uncut demo →**](https://github.com/SkunkWorks0x/twistroll/raw/main/demo/twistroll-live-demo.mov)

---

## What it does

TWiSTroll watches your live transcript via OpenOats and generates live AI reactions from four persona agents. Reactions appear as floating overlay bubbles on your stream — visible to viewers, not hidden in a host window. One reaction every ~15 seconds in round-robin rotation. Each reaction uses ~200 characters max so the bubble never overwhelms the frame.

This is the **viewer-side** layer. Host-facing tools live in a producer's private app window. TWiSTroll lives on the broadcast itself — the second feed Jason described on the March 27 stream.

---

## Live memory (the part Jason was drooling over)

TWiSTroll maintains episode-level memory in three layers — addressing the archive concern from a different angle than cross-episode tools:

**Rolling episode summary.** A background Claude Haiku call regenerates a 3-sentence episode summary every 10 utterances or 5 minutes. Every persona sees this summary in their context, so reactions stay aware of the full conversation arc, not just the last few seconds.

**Callback Engine.** Personas can reference earlier moments from the same episode. In live testing, Not Taco caught Jason saying "no bueno" twenty minutes apart — "'No bueno' — you literally just said it two minutes ago." That's within-episode callback memory firing on unscripted natural conversation.

**Contradiction Catcher.** Not Jamie scans the rolling episode summary for conflicting claims and surfaces them. In live testing against today's TWiST episode: "Guest claims these are suggestions 'you provided Jason' — but the episode summary shows Jason created the initial agent configurations, not provided them to the guest." Continuity-checking in real time.

This is episode-scoped memory, not cross-episode archive. Different approach, real teeth. The cross-episode archive layer is roadmap (see below).

---

## Production features (live tested)

- **Sponsor Guardian.** Detects sponsor mentions and instantly fires a sponsor-styled bubble with the promo URL. Bypasses cooldown. 45-second ad break suppression after firing so the personas don't talk over the read. 12 TWiST sponsors pre-loaded.
- **Jason-ism Detector.** Server-side detection of Jason Calacanis catchphrases. When Jason says one of his signature lines, Not Taco gets forced into the next slot to roast it.
- **Flat reaction filter.** 30+ regex patterns suppress meta-commentary, "I can't fact-check this" leaks, transcription complaints, and out-of-character outputs before they ever reach the WebSocket.
- **Advisor escalation (Not Jamie).** Flag-gated (`NOT_JAMIE_ADVISOR_ENABLED`). When Jamie encounters a claim requiring specific facts beyond his confidence threshold, he escalates to Claude Opus via Anthropic's advisor tool for verification, then delivers the correction in-character.
- **Hybrid LLM with three fallbacks.** Claude Haiku primary, Groq llama-3.3-70b fallback, Ollama qwen2.5:7b last resort. The pipeline never dies.
- **Server-side truncation.** Hard 200-character ceiling, first-sentence cut, word-boundary aware. Reactions stay tight, bubbles stay legible.

---

## Production controls

A config panel at `localhost:3000/config` (never visible in OBS) lets the production team:

- Toggle personas on/off mid-stream
- Adjust cooldown timing in real time
- Thumbs-up / thumbs-down on each reaction
- Monitor connection status and current session
- Copy production OBS URL to clipboard with one click

---

## OBS setup (5 minutes)

1. Add a **Browser** source → URL: `http://localhost:3000?mode=prod`
2. Set width: **340**, height: **1080**
3. Position on the right edge of your canvas, layered above your video source
4. Uncheck "Shutdown source when not visible" and "Refresh browser when scene becomes active"
5. Set FPS to **30**

The overlay background is fully transparent. Bubbles float directly over your video feed.

---

## Quick start

```bash
git clone https://github.com/SkunkWorks0x/twistroll.git
cd twistroll
npm install

cp .env.example .env
# Add your Anthropic API key (or set LLM_MODE=ollama for fully local)

npm run dev
```

For live use: install [OpenOats](https://github.com/yazinsai/openoats), start a session, play audio. TWiSTroll watches the transcript automatically.

For testing without OpenOats:
```bash
./scripts/simulate-session.sh
```

---

## The 4 personas

Each persona reacts once per minute in round-robin rotation. One fresh pop-up every ~15 seconds.

| | Persona | Role | Voice |
|---|---------|------|-------|
| 🔍 | **Not Jamie** | Fact-checker | Dry, deadpan. Always cites a specific fact, number, or correction. |
| 🔥 | **Not Delinquent** | Chaotic troll | Conspiracy-comedy. ALL CAPS emphasis. Excited about insane connections. |
| 😑 | **Not Cautious** | Cynical analyst | Names a specific historical parallel for every hype cycle. Doom-pattern detection. |
| 😂 | **Not Taco** | Comedian | Punchlines only. Callbacks, roasts, one-liners. No setup, no buddy/bro. |

### Why these names?

**Not Jamie** — Jamie Vernon runs the board for Joe Rogan. Every great podcast has a fact-checker.

**Not Delinquent** — Lon Harris played a heel character called "The Delinquent" on Movie Trivia Schmoedown. Our Not Delinquent channels that energy into conspiracy-adjacent takes about startup culture.

**Not Cautious** — Alex Wilhelm publishes "Cautious Optimism," his newsletter on startups and markets. Our most recklessly pessimistic persona is the direct inversion.

**Not Taco** — Lon's foster chihuahua. The funniest persona in the sidebar is named after a tiny rescue dog.

Jason said "not Jackie, not Bob, not Fred — so we don't get in trouble." We took that literally and made every name an Easter egg for the show's actual world.

---

## Architecture

```
Audio → OpenOats (Whisper) → JSONL transcript
  ↓
chokidar watcher
  ↓
parser (10-word min filter)
  ↓
cooldown gate (15s minimum)
  ↓
Sponsor Guardian check (instant fire if matched)
  ↓
rotation selector (round-robin: 1 of 4)
  ↓
context builder (8 utterances + rolling episode summary)
  ↓
LLM call (Claude Haiku → Groq → Ollama)
  ↓
truncation (first sentence, 200 char max)
  ↓
flat reaction filter (30+ patterns)
  ↓
WebSocket broadcast
  ↓
OBS browser source overlay (floating transparent bubbles)
```

One persona fires per utterance in round-robin order: Jamie → Delinquent → Cautious → Taco → repeat. Each reaction takes ~2-4 seconds with Claude Haiku.

---

## LLM modes

| Mode | Speed | Cost | Quality |
|------|-------|------|---------|
| `hybrid` (default) | ~2-4s | ~$0.01/reaction | Best — Claude Haiku |
| `groq` | ~1-2s | Free tier | Good — llama-3.3-70b |
| `ollama` | ~8-15s | Free | Good — qwen2.5:7b, runs 100% local |

Hybrid mode tries Claude Haiku first, falls back to Groq, then Ollama. The pipeline never dies — if cloud is down, local catches it.

---

## System requirements

- **macOS** with Apple Silicon recommended (M1/M2/M3/M4/M5)
- Node.js 20+
- OBS Studio 30+
- For hybrid mode: Anthropic API key
- For local mode: Ollama with `qwen2.5:7b` pulled, 32GB RAM recommended

---

## Configuration

Copy `.env.example` to `.env`. Defaults work out of the box with a Claude API key.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODE` | `hybrid` | `hybrid`, `groq`, or `ollama` |
| `ANTHROPIC_API_KEY` | — | Required for hybrid/cloud mode |
| `GROQ_API_KEY` | — | Optional fallback |
| `OPENOATS_TRANSCRIPT_DIR` | `~/Library/Application Support/OpenOats/sessions` | Where OpenOats writes JSONL files |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Model for local inference |
| `WS_PORT` | `3001` | WebSocket broadcast port |
| `OVERLAY_PORT` | `3000` | Overlay + config panel port |
| `COOLDOWN_MS` | `15000` | Minimum ms between reactions |
| `CONTEXT_BUFFER_SIZE` | `8` | Recent utterances in context |

---

## Roadmap

Built and shipping:

- [x] 4-persona overlay with live reactions
- [x] Round-robin rotation (one pop-up at a time)
- [x] Hybrid LLM with three-tier fallback
- [x] Rolling episode summary memory
- [x] Callback Engine (within-episode memory)
- [x] Contradiction Catcher
- [x] Sponsor Guardian with ad break suppression
- [x] Jason-ism Detector
- [x] 30+ pattern flat reaction filter
- [x] Production config panel with feedback controls
- [x] Timestamped reaction log for editors
- [x] Server-side truncation (200 char ceiling)

Next:

- [ ] Producer approval queue (approve/reject before air, 2-3s buffer)
- [ ] Cross-episode archive memory
- [ ] Audience participation — viewers submit reactions via chat
- [ ] Sponsor integration with custom URLs per show
- [ ] Multi-podcast support — package as "Green Room" for any creator

---

## Built with

- [OpenOats](https://github.com/yazinsai/openoats) — real-time speech transcription
- [Claude Haiku](https://anthropic.com) — fast, high-quality AI reactions (primary)
- [Groq](https://groq.com) — llama-3.3-70b fallback
- [Ollama](https://ollama.com) — local LLM fallback, zero cloud costs
- Node.js + TypeScript — server pipeline
- WebSocket — real-time reaction broadcast
- Vanilla HTML/CSS/JS — OBS browser source overlay

---

## License

MIT — do whatever you want with it.

---

Built by [@SkunkWorks0x](https://x.com/SkunkWorks0x)

*Built for the show. Released for everyone.*
