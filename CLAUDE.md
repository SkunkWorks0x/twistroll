# CLAUDE.md — In-Repo Imperatives

> This file is the rulebook for Claude Code working inside `~/twistroll/`. Read it first, every session. The rules here are hard, not advisory.

---

## Product

TWiST Sentinel. Real-time podcast fact-checker. Single agent: The Docket, with four evidence-locked voice modes (Producer/On-Air/Analyst/Cynic). The Cynic *mode* is a voice setting; it is NOT the Pattern-Recognizer cynic *persona* (deleted May 12, commit 0aec10a — remains deleted). No comedy, no sound effects. Jason's spec: "A real time podcast fact checker."

Pipeline: Deepgram Nova-3 → claim classifier (Haiku) → gate stack (empty-entity → sponsor → speaker-label → weak-entity → entity-cooldown → queue-dedup) → parallel retrieval (LanceDB + Tavily) → The Docket (Haiku, tool_use JSON) → post-processing (Zod, citation cross-check, word limits, anti-pattern scan, LanceDB injection) → WebSocket → browser dashboard.

---

## Shipped

**Customize panel (May 2026):** Dashboard `public/index.html` exposes a runtime panel that mutates The Docket's voice without touching evidence. Controls:

- **Mode** — Producer (default) / On-Air / Analyst / Cynic. Each is a voice fragment (`groundingInstructions`, `explanationVoice`, `verdictGuidance`) interpolated into the Docket prompt.
- **Length** — slider, four stops [20 / 28 / 40 / 80]; Standard 40 default.
- **Strictness** — Tier 1 / Balanced (default) / Broad. Display-filter on source chips; citation pipeline unchanged.
- **Density** — Quiet / Normal (default) / Aggro. Re-routes classifier confidence threshold (0.85 / 0.7 / 0.55).

Mode-invariant: verdict logic, citation cross-check, retrieval, gate stack, post-processing.

**Cynic mode vs. Cynic persona:**

- **Cynic *mode*** — evidence-locked voice setting on The Docket. Higher evidence bar; leans UNVERIFIABLE on thin evidence. Produces structured verdicts with citations. Shipped, on `main`.
- **Cynic *persona*** — the Pattern Recognizer (precedent-based counterarguments, implication language). Deleted May 12 (commit 0aec10a). Remains deleted.
- The word "cynic" in the codebase refers to the mode. Do not halt on it.

**Wiring:**

- `src/server/personaModes.ts` — exports `getPersonaFragment(mode) → { groundingInstructions, explanationVoice, verdictGuidance }`. Also holds wordMax / strictness / density runtime state. **Not sacred** — edit for mode tuning, adding modes, or adjusting defaults.
- `src/server/synthesis.ts` (sacred) — interpolates fragments into Docket system prompt.
- `src/server/index.ts` — `/api/session/mode` GET+POST endpoint for runtime control.
- `public/index.html` (sacred) — customize panel UI and hydrate logic.
- Defaults: Producer mode, Standard 40 wordMax, Balanced strictness, Normal density.
- UI copy below the controls: "Voice changes wording. Evidence stays locked."

---

## Halt conditions

Stop the current task and surface the situation if any of these are true. Do not work around. Do not assume permission.

- The task touches a sacred file (see table below) without explicit scoped permission.
- The diff size or file count exceeds what the prompt predicted.
- The current branch has uncommitted changes from an unrelated task.
- A new dependency is about to be added to `package.json`.
- A change affects the WebSocket message shape or the Docket output schema.
- A deletion targets a file not named in the prompt.
- A smoke check returns an unexpected result. Do not re-run. Do not interpret. Surface verbatim.

When any condition fires, halt, summarize in one paragraph, wait for instruction.

---

## Sacred files

| Path | Why it's sacred |
|------|----------------|
| `src/server/episodeMemory.ts` | LanceDB query path. Corpus integrity. |
| `src/server/synthesis.ts` | Docket prompt, post-processor, citation guardrails, LanceDB injection. |
| `src/server/classifier.ts` | Claim extraction pipeline. Structured output schema. |
| `public/index.html` | Production dashboard. What Jason sees. |

Sacred file edits require all of:
- A founder message with explicit "edit `<path>` to do `<X>`" scope.
- A read-only discovery pass before any write operation.
- Verbatim `old_str` / `new_str` shown in diff preview.
- A single-purpose commit.

---

## Smoke-test discipline

A `tsx` server without `--watch` does not hot-reload. Curl-200s from a stale process lie.

1. `ps aux | grep tsx | grep -v grep` — identify running process.
2. Kill the stale process.
3. Boot fresh: `npx tsx src/server/index.ts`.
4. Confirm boot log shows post-edit code loaded.
5. Then run the smoke check.

If any step fails or is skipped, the smoke result is not trustworthy. Halt and surface.

---

## Scope discipline

**One commit, one variable.** Validation isolation is non-negotiable. Split if a fix touches two unrelated concerns.

**No surprise edits.** Discover a problem outside task scope? Surface it. Do not fix it.

**Diff preview before staging on every sacred-file edit.** Verbatim before/after.

---

## Commit conventions

- Commits land to `main`.
- Messages name the subsystem and change: `feat: strip Pattern Recognizer — Docket-only single-agent architecture`
- One subsystem per commit.
- Push to origin only when the founder says "push."
