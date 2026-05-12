# CLAUDE.md — In-Repo Imperatives

> This file is the rulebook for Claude Code working inside `~/twistroll/`. Read it first, every session. The rules here are hard, not advisory.

---

## Product

TWiST Sentinel. Real-time podcast fact-checker. Single agent: The Docket. No cynic persona, no comedy, no sound effects. Jason's spec: "A real time podcast fact checker."

Pipeline: Deepgram Nova-3 → claim classifier (Haiku) → gate stack (empty-entity → sponsor → speaker-label → weak-entity → entity-cooldown → queue-dedup) → parallel retrieval (LanceDB + Tavily) → The Docket (Haiku, tool_use JSON) → post-processing (Zod, citation cross-check, word limits, anti-pattern scan, LanceDB injection) → WebSocket → browser dashboard.

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
