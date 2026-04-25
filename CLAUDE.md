# CLAUDE.md — In-Repo Imperatives

> This file is the rulebook for Claude Code working inside `~/twistroll/`. Read it first, every session. The rules here are hard, not advisory.

---

## Halt conditions

Stop the current task and surface the situation if any of these are true. Do not work around. Do not assume permission.

- The task touches a sacred file (see table below) and the founder has not given explicit scoped permission for this edit.
- The diff size or file count exceeds what the prompt predicted, without explicit re-scoping from the founder.
- The current branch has uncommitted changes from an unrelated task.
- A new dependency is about to be added to `package.json`.
- A change is about to affect the WebSocket message shape, the persona output schema, or the JSONL transcript format.
- A deletion is about to happen for a file not named in the prompt.
- A smoke check returns an unexpected result. Do not re-run. Do not interpret. Surface the result verbatim.

When any condition fires, halt the write operation, summarize in one paragraph, wait for instruction.

---

## Sacred files

| Path | Why it's sacred |
|---|---|
| `src/server/queue.ts` | Rotation, cooldown, race guards. One bad edit breaks every persona at once. |
| `src/server/personas.ts` | Persona prompts. ANCHOR + CLAIM-SHAPE + voice rules live here. |
| `src/server/episodeMemory.ts` | LanceDB query path. Memory contamination invariant lives here. |
| `src/server/sponsors.ts` | Sponsor Guardian instant-fire path. Bypasses cooldown — high blast radius. |
| `src/server/dossier.ts` | Pre-show guest context injection. |
| `src/overlay/index.html` | Production overlay. What Jason sees. |

Sacred file edits require all of:

- A founder message with explicit "edit `<path>` to do `<X>`" scope.
- A read-only Task 1 report before any write operation.
- Verbatim `old_str` / `new_str` shown in the diff preview, not a footprint summary.
- A single-purpose commit (no bundling unrelated changes).

---

## Smoke-test discipline

A `tsx` server without `--watch` does not hot-reload. Curl-200s from a stale process are worse than 500s from a fresh one — they lie. Every smoke test follows this ritual:

1. Identify the running process: `ps aux | grep tsx | grep -v grep`.
2. Kill the stale process.
3. Boot fresh: `tsx src/server/index.ts` (or whatever the prompt specifies).
4. Confirm the boot log shows the post-edit code is loaded — look for a marker that exists only in the new version.
5. Then run the smoke check.

If any of these steps fails or is skipped, the smoke result is not trustworthy. Halt and surface.

---

## Scope discipline

**One commit, one variable.** Validation isolation is non-negotiable. If a fix touches two unrelated concerns, split the commit. The exception: when bundling preserves attribution better than splitting (e.g., a single rename across N files). When in doubt, split.

**No surprise edits.** If you discover a problem outside the task scope mid-execution, surface it. Do not fix it. Do not "while I'm here" anything.

**Diff preview before staging on every sacred-file edit.** Verbatim before/after. If you only have a footprint table, the founder will ask for the verbatim diff before approving — save the round trip and provide it first.

**Self-corrections are fine.** If a discovery pass produces a wrong inventory and you catch it during execution, correct and proceed. Don't paper over.

---

## Commit conventions

- Commits land straight to `main`. No feature branches at this scale.
- Commit messages name the subsystem and the change shape: `Delinquent: remove duplicate always-fire directive — unblock silence-is-power test`.
- One subsystem per commit. If two subsystems both changed, two commits.
- Push to origin only when the founder says "push." Do not push on your own.

---

## What lives elsewhere

This file covers in-repo discipline. It deliberately does not cover:

- **Strategic context** (why we're building this, what Jason values, demo strategy). Halt and request the relevant section from the founder.
- **Current shipped state, build queue, active concerns.** Lives in `01-current-state.md`. Halt and request the relevant section.
- **Persona voice rules, prompt structure, tuning history.** Lives in `05-personas.md`. Halt and request.
- **Spec language.** Lives in `00-NORTH-STAR-jason-x-post.md`. Halt and request.
- **Three-tool workflow, locked principles.** Lives in `~/.claude/skills/twistroll/SKILL.md`.

If a prompt arrives that asks for an architectural decision rather than execution of a validated decision, halt and request the validation before proceeding.
