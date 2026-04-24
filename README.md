# TWiSTroll

**The viewer-facing AI commentary layer for live podcasts.**

**Status: 8/8 spec compliance against the bounty brief.**

Five AI personas react to your show in real time, displayed as floating bubbles over the broadcast. Built as an OBS browser source — drag, drop, on air. Tested live against multiple TWiST episodes.

Built for the [April 15, 2026 TWiST bounty](https://x.com/twistartups/status/2044437861668171974). Released under MIT for any podcast to use.

![TWiSTroll Demo](https://github.com/SkunkWorks0x/twistroll/raw/main/demo/twistroll-demo.gif)

[**Watch the 7-minute uncut demo →**](https://github.com/SkunkWorks0x/twistroll/raw/main/demo/twistroll-live-demo.mov)

---

## Spec compliance

All 8 requirements from the [@twistartups April 15, 2026 bounty post](https://x.com/twistartups/status/2044437861668171974) are shipped and live-tested.

- [x] **Real-time capabilities** — Listens to the show in real time and provides live feedback through a sidebar
- [x] **Gary (Fact-checker)** → *Not Jamie* — Monitors conversation for factual claims and provides corrections or background data
- [x] **Fred (Sound Effects/Context)** → *Not Fred* — Supplies background context and sound effects (12-sound library, 0.25 volume cap, producer kill switch)
- [x] **Jackie (Comedy Writer)** → *Not Taco* — Generates one-liners or jokes related to the current discussion
- [x] **Troll (Cynical Commentator)** → *Not Delinquent* — Chaotic / negative cynical persona providing troll feedback
- [x] **Bubble UI with profile picture** — Pop-and-vanish bubbles with character SVG avatars per persona
- [x] **Visual sine wave** — Animates per-persona color when speaking/active
- [x] **Two-stream output** — OBS scene structure produces both regular and enhanced streams

---

## What it does

TWiSTroll watches your live transcript via OpenOats and generates live AI reactions from four persona agents. Reactions appear as floating overlay bubbles on your stream — visible to viewers, not hidden in a host window. One reaction every ~15 seconds in round-robin rotation. Each reaction uses ~200 characters max so the bubble never overwhelms the frame.

This is the **viewer-side** layer. Host-facing tools live in a producer's private app window. TWiSTroll lives on the broadcast itself — the second feed Jason described on the bounty stream.

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
6. On the source's **Advanced Audio Properties**, set monitoring to **"Monitor and Output"** — required so Fred's sound cues reach both the host and the broadcast.

The overlay background is fully transparent. Bubbles float directly over your video feed.

---

## OBS setup for Fred sound effects

OBS's browser source runs on CEF (Chromium Embedded Framework), which enforces Chrome's autoplay policy. `Audio.play()` is blocked until the page receives a user gesture. The overlay auto-detects OBS via `window.obsstudio` and **never shows the unlock prompt inside OBS** — instead, the producer unlocks audio with a single click on the scene preview.

1. **Click the rendered overlay once in your scene preview** after adding the source. This single click satisfies CEF's autoplay policy and enables Fred's sound effects for the session.
2. In the browser source properties, check **"Control audio via OBS"**. This routes Fred's audio through OBS's audio mixer so you can control volume independently of the show's main audio. Note: this setting handles audio *routing*, not autoplay unlock — step 1 is still required.
3. In the OBS Audio Mixer, the browser source appears under whatever name you gave it. Set the slider to a comfortable level. Fred's sounds are already capped at 25% by the overlay code, but OBS gives you a master override on top of that.
4. If you reload the browser source or restart OBS, repeat step 1 (single click on the source preview) to re-enable audio for the new session.

When the overlay is loaded in a regular browser for testing (not OBS), a compact centered **"Click to enable Fred audio"** prompt appears if Layer A silent unlock fails. Click it once — audio is unlocked for the rest of the session.

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

Each persona reacts in round-robin rotation: Jamie → Delinquent → Taco → Fred. One fresh pop-up every ~15 seconds.

| Persona | Role | Color | Voice |
|---------|------|-------|-------|
| **Not Jamie** | Fact-checker | Teal (`#2DD4BF`) | Dry, precise, deadpan. Always cites a specific fact, number, or correction. |
| **Not Delinquent** | Chaotic troll | Orange (`#F97316`) | Conspiracy-comedy. ALL CAPS emphasis. Excited about insane connections. |
| **Not Taco** | Comedy writer | Lime (`#84CC16`) | Tight punchlines, callbacks, roasts. No emojis, no setup, no buddy/bro. |
| **Not Fred** | Sound effects + context | Crimson (`#EF4444`) | Producer energy — drops a sound cue plus one line of archival color. |

### Why these names?

**Not Jamie** — Jamie Vernon runs the board for Joe Rogan. Every great podcast has a fact-checker.

**Not Delinquent** — Lon Harris played a heel character called "The Delinquent" on Movie Trivia Schmoedown. Our Not Delinquent channels that energy into conspiracy-adjacent takes about startup culture.

**Not Taco** — Lon's foster chihuahua. The funniest persona in the sidebar is named after a tiny rescue dog.

**Not Fred** — Jason literally said "not Fred" on the bounty stream as a name to avoid. We took it literally, made it the sound-effects operator, and gave it the crimson accent. The joke writes itself.

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

One persona fires per utterance in round-robin order: Jamie → Delinquent → Taco → Fred → repeat. Each reaction takes ~2-4 seconds end-to-end.

---

## LLM modes

| Mode | Speed | Cost | Quality |
|------|-------|------|---------|
| `hybrid` (default) | ~2-4s | ~$0.01/reaction | Best — Claude Haiku |
| `groq` | ~1-2s | Free tier | Good — llama-3.3-70b |
| `ollama` | ~8-15s | Free | Good — qwen2.5:7b, runs 100% local |

Hybrid mode tries Claude Haiku first, falls back to Groq, then Ollama. The pipeline never dies — if cloud is down, local catches it.

### Per-persona routing (locked)

Each persona has a primary model plus a multi-tier fallback. Jamie and Fred want factual precision; Delinquent and Taco want speed and comedic timing.

| Persona | Primary | Fallback chain |
|---------|---------|----------------|
| Not Jamie | Claude Haiku 4.5 | Groq → Ollama |
| Not Fred | Claude Haiku 4.5 | Groq → Ollama |
| Not Delinquent | xAI Grok 4.1 Fast | Haiku → Groq → Ollama |
| Not Taco | xAI Grok 4.1 Fast | Haiku → Groq → Ollama |

Each step has a hard timeout; if the primary misses the window, the next tier takes over in under a second.

---

## Bonus features beyond spec

Shipped beyond the bounty requirements:

- **Cross-Episode Memory** — LanceDB vector store of prior-episode highlights for future callback work.
- **Pre-show Guest Dossier** — Claude-generated background pack on each booked guest, dropped into `data/dossiers/`.
- **Hybrid LLM fallback chain** — Haiku ↔ Grok ↔ Groq ↔ Ollama; the pipeline never dies.

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

- [x] 4-persona overlay with live reactions (Jamie, Delinquent, Taco, Fred)
- [x] Per-persona LLM routing (Haiku for fact-check/sound, Grok for comedy)
- [x] Hybrid LLM with multi-tier fallback (Haiku ↔ Grok ↔ Groq ↔ Ollama)
- [x] Not Fred sound-effects system with 12 curated cues
- [x] Rolling episode summary memory
- [x] Callback Engine (within-episode memory)
- [x] Contradiction Catcher
- [x] Sponsor Guardian with ad break suppression
- [x] Jason-ism Detector
- [x] Pre-show guest dossier
- [x] Audience Pulse tracking
- [x] 30+ pattern flat reaction filter
- [x] Production config panel with feedback controls
- [x] Timestamped reaction log for editors
- [x] Server-side truncation (220 char ceiling)

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
