# 00 — NORTH STAR

> **This file is the spec. Everything we build traces back to this. If a feature isn't required by this post, it's a bonus — not a priority. If a feature IS required by this post and isn't shipped, we fail.**

> **Spec source:** Updated April 15, 2026. The previous April 14 post listed five personas; the active April 15 repost listed four. The four-persona spec is the locked target.

---

## Source: Official @twistartups X post — April 15, 2026

**Link:** https://x.com/twistartups/status/2044437861668171974

**Verbatim (preserved exactly as posted):**

> $5,000 + a guest spot on the show. Here's what you have to build:
>
> A live AI sidebar with 4 personas watching the pod in real time:
>
> A stern producer keeping facts straight
> A cynical troll
> A chaos agent
> A joke writer
>
> Open source. Ship it and it's yours.
>
> So who's building this?
>
> Requirements:
> Real-Time Capabilities: It must listen to the show in real time and provide live feedback through a sidebar.
>
> Personas:
> The tool should feature four distinct AI personas, inspired by the staff of the Howard Stern Show.
>
> The Fact-checker (Gary Dell'Abate): Monitors the conversation for factual claims and provides corrections or background data (e.g., verifying population statistics).
>
> The Sound Effects/Context (Fred Norris): Supplies background context and sound effects.
>
> The Comedy Writer (Jackie Martling): Generates one-liners or jokes related to the current discussion.
>
> The Cynical Commentator (Troll): A "chaotic" or "negative cynical" persona to provide "troll" feedback.
>
> UI Elements: Each persona should be represented by a "bubble" with a profile picture and a visual sine wave to indicate when they are "speaking" or active.
>
> Output: The final product would result in two streams: a regular show stream and an "enhanced" version with the AI sidebar.

---

## Spec interpretation decisions (locked by Imani)

| Ambiguity | Decision | Reasoning |
|-----------|----------|-----------|
| "Sound effects" — literal audio or text-based? | **Literal audio playback.** Fred ships with real sound effects + 0.25 volume cap + producer kill switch. | Spec says "sound effects" not "sound effect descriptions." |
| "Two streams" output requirement | **Already handled by OBS scene structure.** Producer outputs one scene with TWiSTroll layered in (enhanced), one without (regular). No code change required. | Standard OBS multi-scene workflow. README documents this. |
| Persona names — Stern names or original TWiSTroll names? | **Keep "Not [X]" naming.** Maps to Stern roles internally. | The inside-joke naming earned Jason's first positive reaction on the original Friday stream. |

---

## Spec compliance tracker (April 15 spec — 4 required personas)

| Requirement | Status | Notes |
|-------------|--------|-------|
| Real-time listen + sidebar | ✅ SHIPPED | OpenOats → watcher → queue → WebSocket → OBS overlay |
| Gary (Fact-checker) | ✅ SHIPPED | Not Jamie — dry fact-checker, cross-episode memory, KB |
| Fred (Sound Effects/Context) | ✅ SHIPPED | Not Fred — JSON output, 12-sound library, 0.25 volume cap, producer kill switch |
| Jackie (Comedy Writer) | ✅ SHIPPED | Not Taco — one-liner punchlines, callbacks, no emojis |
| Troll (Cynical Commentator) | ✅ SHIPPED | Not Delinquent — chaotic conspiracy-comedy, ANCHOR + CLAIM-SHAPE rules, 0 fab on Ep 2186 replay |
| Bubble UI with profile picture | ✅ SHIPPED | Pop-and-vanish bubbles with character SVG avatars |
| Sine wave when active | ✅ SHIPPED | CSS-only, GPU-composited, per-persona color, Fred stronger pulse during audio |
| Two-stream output (regular + enhanced) | ✅ SUPPORTED | OBS scene structure handles this; documented in README |

**Spec compliance: 8/8 requirements shipped.**

---

## Bonus over-delivery (not required by spec)

These differentiate TWiSTroll from any other submission. They are NOT required by the April 15 bounty post.

- **Sponsor Guardian** — 12 sponsors, instant-fire, bypasses cooldown, 45-second ad break suppression
- **Cross-Episode Memory** — LanceDB + EmbeddingGemma, 21+ episodes backfilled, contextual recall for fact-checks
- **Pre-show Guest Dossier** — structured context injection per guest
- **Hybrid LLM stack** — Claude Haiku + Grok 4.1 Fast + Groq + Ollama with intelligent fallback chains
- **5 rounds of anti-fabrication tuning on Delinquent** — ANCHOR RULE + CLAIM-SHAPE RULE
- **Producer config panel** at localhost:3000/config with persona toggles, Fred audio kill switch, volume control

**These are the $10K differentiators. They prove TWiSTroll isn't a bounty entry — it's a production intelligence layer.**
