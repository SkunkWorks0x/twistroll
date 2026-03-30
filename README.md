# 🔴 TWiSTroll

**AI troll sidebar for live podcasts — built on OpenOats**

4 AI personas deliver live trailing commentary on your podcast — fact-checker, chaotic troll, cynical troll, comedian. Reactions pop up every ~15 seconds as floating bubbles over your video feed (think VH1 Pop Up Video, not live captions). Runs on a MacBook with cloud AI for speed.

48-hour proof of concept built for the [March 27, 2026 TWiST bounty](https://x.com/TWiStartups). Fully working today. Producer moderation layer is next.

![TWiSTroll Demo](https://github.com/SkunkWorks0x/twistroll/raw/main/demo/twistroll-demo.gif)

---

## Production Controls

Toggle personas on/off, adjust cooldown timing, thumbs-up/down reactions, connection status — all at `localhost:3000/config`. Never visible in OBS. One-click "Copy OBS URL" button for the production team.

![Config Panel](https://github.com/SkunkWorks0x/twistroll/raw/main/demo/config-panel.png)

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/SkunkWorks0x/twistroll.git
cd twistroll
npm install

# 2. Configure
cp .env.example .env
# Add your Anthropic API key to .env (for Claude Haiku reactions)
# Or set LLM_MODE=ollama for fully local inference

# 3. Run
npm run dev

# 4. Quick test (no OpenOats needed)
./scripts/simulate-session.sh    # In a second terminal
# Open localhost:3000 to see reactions
```

For live use: install [OpenOats](https://github.com/yazinsai/openoats), start a session, play audio. TWiSTroll watches the transcript and reacts automatically.

---

## OBS Setup

1. Add a **Browser** source → URL: `http://localhost:3000?mode=prod`
2. Set width: **340**, height: **1080**
3. Position on the right edge of your canvas, layered above your video source
4. Uncheck "Shutdown source when not visible" and "Refresh browser when scene becomes active"

The overlay background is fully transparent — bubbles float directly over your video feed.

---

## Known Limitations

This is a weekend proof of concept. Transparency about what it doesn't do yet:

- **No live moderation.** Reactions go straight to the overlay. A producer approval queue (approve/reject before reactions hit stream) is the first production upgrade — see From Demo to Air below.
- **Occasional flat or off-target reactions.** Prompt constraints and cooldowns prevent most wild outputs, but the AI occasionally misreads context — especially on vague statements. Producer approval queue is the live safeguard.
- **Transcription accuracy.** OpenOats uses Whisper, which occasionally mishears words. The personas work around imperfect input, but some reactions may reference misheard content.

---

## The 4 Personas

| | Persona | Role | Voice |
|---|---------|------|-------|
| 🔍 | **Not Jamie** | Fact-checker | Dry, deadpan. Always includes a specific fact, number, or correction. |
| 🔥 | **Not Delinquent** | Chaotic troll | Conspiracy-comedy. ALL CAPS emphasis. Excited about insane theories. |
| 😑 | **Not Cautious** | Cynical troll | Everything is a bubble. Every success is temporary. Deadpan doom. |
| 😂 | **Not Taco** | Comedian | Punchlines only. Callbacks, roasts, one-liners. No setup. |

Each persona reacts once per minute in round-robin rotation. One fresh pop-up every ~15 seconds.

---

## Why These Names?

The names aren't random. Each one references the hosts — Jason's world, Lon's history, Alex's brand.

**Not Jamie** — Every great podcast has a fact-checker. Jamie Vernon runs the board for Joe Rogan. Not Jamie runs the facts for TWiST.

**Not Delinquent** — Lon Harris played a heel character called "The Delinquent" on Movie Trivia Schmoedown. Our Not Delinquent channels that energy into conspiracy-adjacent takes about startup culture.

**Not Cautious** — Alex Wilhelm publishes "Cautious Optimism," his newsletter on startups and markets. Our most recklessly pessimistic persona is the direct inversion. Where Alex is cautiously optimistic, Not Cautious sees bubbles everywhere.

**Not Taco** — Lon's foster chihuahua. The funniest persona in the sidebar is named after a tiny rescue dog.

*Jason said "not Jackie, not Bob, not Fred — so we don't get in trouble." We took that literally and made every name an Easter egg.*

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
                    rotation selector (round-robin: 1 of 4)
                                    ↓
                context builder (last 4 utterances + system prompt)
                                    ↓
              LLM call (Claude Haiku → Groq fallback → Ollama fallback)
                                    ↓
                  truncation (first sentence, 160 char max)
                                    ↓
                        WebSocket broadcast
                                    ↓
                    OBS browser source overlay
                      (floating transparent bubbles)
```

One persona fires per utterance in round-robin order: Jamie → Delinquent → Cautious → Taco → repeat. Each reaction takes ~2-4 seconds with Claude Haiku, ~8-15 seconds with local Ollama.

---

## LLM Modes

TWiSTroll supports three LLM backends, configurable via `LLM_MODE` in `.env`:

| Mode | Speed | Cost | Quality |
|------|-------|------|---------|
| `hybrid` (default) | ~2-4s | ~$0.01/reaction | Best — Claude Haiku |
| `groq` | ~1-2s | Free tier | Good — Llama 3 |
| `ollama` | ~8-15s | Free | Good — qwen2.5:7b, runs 100% local |

Hybrid mode tries Claude Haiku first, falls back to Groq, then Ollama. The pipeline never dies — if cloud is down, local catches it.

---

## From Demo to Air

This is a working proof of concept built in a weekend. Here's what a production deployment for live broadcast needs:

**Producer moderation layer.** Before any reaction hits the stream, a producer sees it first with approve/reject/edit controls. 2-3 second buffer. Non-negotiable for live TV. The config panel is the foundation — the approval queue is a weekend of work on top of it.

**Kill switch.** One button to blank all bubbles instantly. Already possible by disabling all personas in the config panel, but a dedicated panic button is cleaner.

**Faster models.** Claude Haiku keeps reactions under 4 seconds. For sub-second latency, Groq with Llama 3 is the path. Pipeline is model-agnostic — one `.env` change.

---

## Project Structure

```
twistroll/
├── src/
│   ├── server/
│   │   ├── index.ts          # Express + WebSocket server
│   │   ├── watcher.ts        # chokidar file watcher, byte offset tracking
│   │   ├── parser.ts         # OpenOats JSONL parser
│   │   ├── queue.ts          # Round-robin persona rotation, single LLM call
│   │   ├── ollama.ts         # Ollama API client
│   │   ├── context.ts        # Rolling buffer of last 4 utterances
│   │   ├── feedback.ts       # JSON feedback store (thumbs-up/down)
│   │   ├── logger.ts         # Timestamped reaction log for editors
│   │   ├── personas.ts       # 4 persona system prompts
│   │   └── kb/
│   │       └── factcheck.md  # Static knowledge base for Not Jamie
│   ├── overlay/
│   │   └── index.html        # OBS browser source (floating popup bubbles)
│   └── config/
│       └── config.ts         # .env loading
├── data/
│   ├── feedback.json         # Thumbs-up/down storage. Persists across sessions.
│   └── reactions.log         # Timestamped log for editors.
├── scripts/
│   └── simulate-session.sh   # Test without OpenOats
├── .env.example
├── package.json
└── LICENSE (MIT)
```

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
| `CONTEXT_BUFFER_SIZE` | `4` | Recent utterances in context |

---

## System Requirements

- **macOS** with Apple Silicon recommended (M1/M2/M3/M4/M5)
- Node.js 20+
- OBS Studio 30+
- For hybrid mode: Anthropic API key
- For local mode: Ollama with `qwen2.5:7b` pulled, 32GB RAM recommended

---

## Roadmap

- [x] 4-persona overlay with live reactions
- [x] Round-robin rotation (one pop-up at a time)
- [x] Hybrid LLM (Claude Haiku + Groq + Ollama fallback)
- [x] Production config panel with feedback controls
- [x] Timestamped reaction log for editors
- [ ] Producer approval queue (approve/reject before air)
- [ ] Audience participation — viewers submit troll reactions via chat
- [ ] Sponsor integration — "This fact-check brought to you by..."
- [ ] Multi-podcast support — package for any creator

---

## Built With

- [OpenOats](https://github.com/yazinsai/openoats) — real-time speech transcription
- [Claude Haiku](https://anthropic.com) — fast, high-quality AI reactions (primary)
- [Ollama](https://ollama.com) — local LLM fallback, zero cloud costs
- Node.js + TypeScript — server pipeline
- WebSocket — real-time reaction broadcast
- Vanilla HTML/CSS/JS — OBS browser source overlay

---

## License

MIT — do whatever you want with it.

---

Built by [@SkunkWorks0x](https://x.com/SkunkWorks0x)

*Built as a love letter to TWiST and proof that one builder + local AI can ship broadcast tools in a weekend.*
