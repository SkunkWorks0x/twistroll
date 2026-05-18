# Audit Findings — Deferred Items

Date: 2026-05-18
Source: Full-codebase audit (4 parallel agents + direct reads of `src/server/index.ts` and `public/index.html`)
Fixed in commits: `82b75f0`, `496747c`, `bac75de`, `ce8b3f7`, `f3f8d84`, `f1ae1b2`, `f30dd7b`, `9f9d29d`, `530ff87`

This file logs bugs the audit surfaced but did NOT fix in the sweep. Each entry is real, not a guess. Severity and rationale for deferral are honest.

---

## BLOCKING (deferred — fix exceeds 10 lines + design uncertainty)

### `episodeMemory.ts:442-484` — commitEpisode non-atomic
Read-add-delete pattern. Crash between `tbl.add(updated)` and `tbl.delete(whereClause)` leaves both `provisional=true` AND `provisional=false` copies of the same chunks. LanceDB has no transaction primitive in its current public API. Genuine atomicity requires either:
- Write-ahead journal pattern (write pending-commit marker to disk, replay on boot)
- An "upsert by id" primitive that LanceDB doesn't expose

Fix is multi-day and design-load-bearing.

### `retrieval.ts:198, 632` — `withTimeout` leaks background promises
The race-based timeout doesn't abort the underlying Tavily/LanceDB SDK call. After timeout, the original call continues running in the background, may eventually call `recordSuccess` on the dead promise's source. Under load this piles up in-flight HTTP/embed calls. **Fix blocked upstream:** `@tavily/core` and `@lancedb/lancedb` neither accept an `AbortSignal` on their search methods. Plumbing a controller through `withTimeout` would be cosmetic until SDKs expose abort.

### `retrieval.ts:453` — Tavily 429 backoff
No special handling for rate-limit responses. Falls through to breaker after 5 failures. Real fix needs (a) error-shape inspection (SDK doesn't document throw envelope), (b) Retry-After header respect, (c) exponential delay between requests. >10 lines, brittle without SDK docs.

---

## FUNCTIONAL (deferred — load-bearing on dead-code paths)

### `llm-router.ts:27` — Dead PersonaId routing
`ROUTING` table has entries for `'not-jamie'` and `'not-delinquent'` — residue from pre-strip troll product. Per `CLAUDE.md`, Sentinel is single-agent (The Docket). The ROUTING table and its keys are dead in the live pipeline. Gated by the CLAUDE.md "WS message shape change" halt because `WSMessage` union still includes `TrollReaction`.

### `types.ts:17, 18, 27-33, 162-176` — Dead types
`PersonaId`, `AgentId`, `TrollReaction`, `PersonaConfig`, `FeedbackData` are all pre-strip residue. Same halt condition.

### `synthesis.ts:753` — `contradictionDisabledLogged` module-level mutable
Once-log flag leaks between test isolation contexts. Harmless in production.

### `classifier.ts:213-216` — `confidence=0` sentinel collision
Out-of-range confidence parses to `0`, indistinguishable from Haiku genuinely returning `0.0`. Downstream gates can't tell parse-failure from low-confidence. Fix: `-1` or `NaN` sentinel + a separate `parseOk` flag.

### `classifier.ts:122-129` — `labelToSegmentId` regex non-anchored
`/seg(\d+)/i` matches inside words ("segment3", "Section 1"). Should be `/^seg(\d+)$/i`.

### `classifier.ts:220` — `reason` length not enforced
Prompt says "under 15 words"; runtime accepts any string. Log bloat risk.

### `synthesis.ts:104-107` — Anti-pattern `DOCKET_PARTIAL_ALLOWED` design fragility
Allow-set is single-token; multi-word entries in `DOCKET_ANTI_PATTERNS` fall through. Works today; fragile to future additions.

### `synthesis.ts:511-519` — Dangling-citation footprint on word-count drop
Citation appended before word-count check at line 502-505. If `appended > 28 words`, the appended text drops but citation stays in the array. Either keep both or drop both.

### `synthesis.ts:495-499` — `archiveTitle` null-fallback
If `metadata.episodeNumber` is null on a LanceDB row, archiveTitle becomes "TWiST Ep null (...)". Guard with `?? '?'`.

### `episodeMemory.ts:248-250` — Silent query-error swallow
`.catch(() => [])` on existing-chunk query. If table is corrupted or schema-migration failed, ingest silently proceeds with DUPLICATES. Log the error.

### `episodeMemory.ts:493` — UTF-16 surrogate split
`text.slice(0, 280)` for snippet truncation can split mid-multibyte-char on non-ASCII content.

### `ollama.ts:25, 85` — Unreachable branch
Loop bound `attempt < 2` + throw on `attempt===1` means line 85 `throw new Error('Ollama call failed after retries')` is unreachable.

### `ollama.ts:116` — `trimToSentences` misses unterminated final sentence
Regex `[^.!?]+[.!?]+` requires terminal punctuation; unpunctuated final clause passes through full untrimmed.

### `dossier.ts:17` — Unicode name loss
`slugify` strips non-`\w\s-` chars; `José` → `jos`. Low priority for TWiST use case.

### `retrieval.ts:471` — `maxResults: 5` vs `MAX_TAVILY_RESULTS: 6`
SDK request capped at 5; post-dedupe limit of 6 unreachable. Pre-dedupe pool smaller than post-dedupe gate.

### `retrieval.ts:259` — `id` collision risk
`lance_${bucket}_${ep}_${i}_${Date.now()}` — two parallel queries in same ms with same episode collide.

### `retrieval.ts:746` — Dead `speakerId` parameter
`formatSpeakerLine(speakerId)` unused.

### `deepgram.ts:34` — `redactUrls` misses scheme-less creds
Pattern matches only `https?://...`. `user:pass@host` (no scheme) slips through if any tooling emits it in stderr.

### `deepgram.ts:598` (system-audio ffmpeg spawn) — Missing `'error'` handler
Same ENOENT pattern as the 3 sites fixed in `82b75f0`, but not in user's named-3 list. If ffmpeg ENOENTs on system-audio start, async `'error'` event has no handler → uncaught exception.

### `episodeMemory.ts:263` — Sequential `embedText` loop
N-chunk ingest = N sequential Ollama calls. Should batch or `Promise.all`. Performance, not correctness.

### `episodeMemory.ts:27-36` — `EXCLUDE_EPISODE_ID` at module-load
Resolved once at import; changing env mid-process has no effect.

---

## COSMETIC (deferred — non-functional, log only)

- `synthesis.ts:26, 87` — Hardcoded `PROVIDER_TIMEOUT_MS=10_000` and `LANCEDB_INJECTION_SCORE_FLOOR=0.45`; not env-tunable. Cleanup eligible.
- `synthesis.ts:108` — `scanBlocklist` (now fixed for word-boundary) compiles regex per scan; memoize via module-level map of pattern → RegExp.
- `entityAliases.ts:50` — `aliasPattern` rebuilds RegExp per call per alias. Memoize.
- `llm-router.ts:121, 218` — Redundant `clearTimeout` (called both inside try and in finally).
- `ollama.ts:100` — `checkOllama` returns the singleton instead of local `res.ok` — same value, but creates ordering coupling.
- `ollama.ts:113` — Quote-strip regex only removes one leading and one trailing quote.
- `public/index.html` (post-fix) — `role-unmapped` CSS rules at lines 231, 237 are now dead code (no producer emits the class).
- `public/index.html` (post-fix) — `resolveCardSpeaker` null-branch at lines 1151-1153 is unreachable.
- `public/index.html:1107-1119` — Comment block references "SPEAKER N" fallback that no longer exists (after `f8e74bf`).

---

## SAFE / NOT BUGS (verified)

- `ttfcStages.ts` — Map insertion-order invariant holds (in-place mutation preserves order). Cap + TTL work as designed.
- `dossier.ts` — `slugify` blocks path traversal (`[^\w\s-]` strips `.` and `/`).
- `retrieval.ts` circuit breaker — 5-failures-then-reset cooldown verified working.
- `types.ts` `SessionError.code` union — 10/10 codes match emissions.
- `claimQueue.ts` cooldown registration after admission (`50dd272` fix) — both admission paths register, no path skips.
- `claimQueue.ts` Map mutation during for-of in `pruneCooldowns` — spec-safe.

---

## Triage notes for next maintenance pass

Highest-leverage cleanups (each can be a focused commit):
1. `commitEpisode` journal-based atomicity (BLOCKING-grade, multi-day)
2. SDK-level abort signal support landing in `@tavily/core` and `@lancedb/lancedb` (upstream, not us)
3. Troll-residue strip across `llm-router.ts` / `types.ts` (gated by WS-shape halt; coordinate with dashboard)
4. `synthesis.ts` hardcoded constants → env-tunable
5. `classifier.ts` `confidence` sentinel + label regex anchor
