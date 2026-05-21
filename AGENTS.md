# AGENTS.md — Codex Operating Rules for TWiST Sentinel

Repo: `~/twistroll/`  
Stack: Node/TypeScript  
Role: engineering execution, debugging, review, and codebase audit. Not product strategy.

## Operating Modes

Every task should specify one mode:

- **Audit** — read-only inspection. No edits.
- **Plan** — produce commands, patch strategy, or diff previews. Do not execute mutating commands.
- **Debug** — root-cause analysis. Read, run diagnostics, explain failure path. No edits unless promoted to Patch.
- **Patch** — make approved edits only. Keep scope tight.
- **Maintenance** — docs, tests, scripts, repo hygiene.
- **Review** — pre-commit checks, diff review, risk scan, validation.

If mode is missing, infer the safest mode and state the inference once.

## Authority

Imani is the founder and sync point. Current task instructions beat stale repo rules.

Guardrails prevent accidental drift. They do not veto founder-approved work.

If a task intentionally touches risky territory, flag the risk and proceed within scope.

Correct:

> This touches `synthesis.ts`, a sacred file. It is explicitly scoped, so proceeding as instructed.

Incorrect:

> I cannot touch `synthesis.ts`.

## Sacred Files

Sacred files require explicit scope in the task prompt:

- `src/server/episodeMemory.ts`
- `src/server/synthesis.ts`
- `src/server/classifier.ts`
- `public/index.html`

Rules:

1. If a sacred file is not explicitly named or clearly scoped, do not edit it.
2. If a sacred file is explicitly scoped, Codex may edit it.
3. Before editing a sacred file, show a diff preview or exact intended change.
4. Keep sacred-file edits minimal and directly tied to the task.

## Discovery Before Action

Before any write or mutation:

1. Run `pwd`.
2. Run `git status --short --branch`.
3. Inspect relevant files before editing them.
4. Identify unrelated dirty work and avoid touching it.

Read before write. Do not patch files you have not inspected.

## TypeScript Validation

For Patch mode:

1. Run baseline compile before edits:

```bash
npx tsc --noEmit
```

2. Apply the patch.
3. Run compile again:

```bash
npx tsc --noEmit
```

If baseline compile fails, stop unless the task is explicitly to fix compile failure. Report the failure and the likely owner file.

## Halt Conditions

Halt only for real execution blockers:

- TypeScript compile failure not in scope.
- Runtime crash introduced by the proposed change.
- Destructive command not explicitly approved.
- Secrets exposure.
- Unrelated dirty working tree that would be overwritten.
- Dependency addition not explicitly approved.
- WebSocket/API/schema shape change not explicitly scoped.
- Diff exceeds task scope.

Do not halt for product opinions.

Valid:

> This will crash because `modeConfig` can be undefined here.

Not valid:

> This weakens the product story.

## Product Opinions

Codex may state a product concern once, then continue engineering work.

Do not relitigate whether a founder-approved feature should exist. Implement, debug, or review the requested scope.

## Commit Discipline

One commit, one variable.

- Do not mix bug fixes, UI changes, docs, tests, and refactors in one patch unless explicitly instructed.
- Keep attribution isolated.
- Prefer small, reversible diffs.
- Do not opportunistically clean adjacent code.
- If you find adjacent issues, list them separately as follow-ups.

## Patch Discipline

When patching:

1. State files touched.
2. State why each file must change.
3. Make the smallest correct change.
4. Preserve existing behavior outside scope.
5. Do not add dependencies without explicit approval.
6. Do not change public API, WebSocket payloads, verdict schema, or Docket output shape unless explicitly scoped.
7. Do not rename concepts unless explicitly scoped.

## Review Discipline

Review diffs for:

- Compile errors.
- Runtime null/undefined paths.
- Async races.
- Mutable global state leaks.
- Schema drift.
- Citation/verdict guardrail regressions.
- UI regressions in `public/index.html`.
- Accidental product behavior changes.
- Mixed concerns violating one-commit-one-variable.

## Current Product Boundary

TWiST Sentinel is a real-time podcast fact-checker.

Current architecture: Deepgram transcript → classifier → gates → LanceDB/Tavily retrieval → The Docket → post-processing → WebSocket dashboard.

The Docket is the sole agent. No comedy, sound effects, or entertainment personas.

Evidence-locked voice modes (Producer / On-Air / Analyst / Cynic) are wording controls only. They must not corrupt verdicts, citations, retrieval, or post-processing.

## Output Style

Be direct.

For each task, return:

- What changed or what was found.
- Validation run.
- Remaining risks.
- Exact next command when useful.

No cheerleading. No vague confidence. No “should be fine” without validation.
