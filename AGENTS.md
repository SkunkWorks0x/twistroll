# AGENTS.md - Codex Rules for TWiST Sentinel

Read this before working in this repo. These rules are mandatory for Codex in
`~/twistroll/`.

## Product

TWiST Sentinel is a real-time podcast fact-checker. The product uses one agent:
The Docket. Do not add a cynic persona, comedy, or sound effects.

Pipeline: Deepgram Nova-3 -> claim classifier (Haiku) -> gate stack -> parallel
retrieval (LanceDB + Tavily) -> The Docket (Haiku, tool_use JSON) ->
post-processing -> WebSocket -> browser dashboard.

## Halt Conditions

Stop and surface the situation before continuing if any of these occur:

- The task touches a sacred file without explicit scoped permission.
- The diff size or file count exceeds what the prompt predicted.
- The branch has unrelated uncommitted changes.
- A new dependency is about to be added to `package.json`.
- A change affects the WebSocket message shape or Docket output schema.
- A deletion targets a file not named in the prompt.
- A smoke check returns an unexpected result. Do not re-run or interpret it.

## Sacred Files

These files require explicit scoped permission before edits:

- `src/server/episodeMemory.ts` - LanceDB query path and corpus integrity.
- `src/server/synthesis.ts` - Docket prompt, post-processor, citation
  guardrails, LanceDB injection.
- `src/server/classifier.ts` - Claim extraction pipeline and structured output
  schema.
- `public/index.html` - Production dashboard.

For sacred-file edits, first do a read-only discovery pass, preview the exact
before/after diff, and keep the commit single-purpose.

## Smoke Tests

A `tsx` server without `--watch` does not hot-reload. Curl checks against stale
processes are not trustworthy.

Before smoke testing:

1. Run `ps aux | grep tsx | grep -v grep`.
2. Kill any stale process.
3. Boot fresh with `npx tsx src/server/index.ts`.
4. Confirm the boot log shows the edited code loaded.
5. Run the smoke check.

If any step fails or is skipped, halt and report that the smoke result is not
trustworthy.

## Scope Discipline

- One commit, one variable.
- Do not make surprise edits.
- If you discover an out-of-scope issue, surface it instead of fixing it.
- Preview diffs before staging any sacred-file edit.

## Commit Rules

- Commits land to `main`.
- Use messages that name the subsystem and change.
- Keep one subsystem per commit.
- Push to origin only when explicitly told to push.
