# TWiST Sentinel E2289 Soak Test

## Summary

- Episode: TWiST E2289, "The Self-Driving Startup Nobody Saw Coming"
- Duration: intended 90-minute soak; pasted log covers startup through clean `SIGINT` shutdown
- Mode: local Mac system audio through BlackHole 2ch
- Total segments: not emitted as an aggregate in the pasted terminal log
- Claim candidates observed: 86 above-threshold `Claim detected` events plus 1 below-threshold claim
- Claims processed by retrieval: 36 observed retrieval runs
- Claims broadcast/rendered: 12 observed `ttfc-client` render acknowledgements
- Verdict distribution among rendered cards:
  - TRUE: 0
  - FALSE: 1
  - MISLEADING: 1
  - PARTIAL: 7
  - UNVERIFIABLE: 3
- Crashes: 0
- Deepgram reconnects: 0 observed
- Unhandled rejections: 0 observed
- Shutdown: clean `SIGINT` drain, Deepgram session stopped, WebSocket client disconnected, process exited cleanly

## Timeline

| Timestamp | claimId | primaryEntity | verdict | Retrieval sources | TTFC total ms | Notes |
| --- | --- | --- | --- | --- | ---: | --- |
| startup + first claim | `3ebda170` | Tesla | UNVERIFIABLE | lance 0 / tavily 5 / grokipedia 0 | 5,325 | Claim about 25,000-car partnership volume vs Tesla annual builds. Tavily returned tangential Tesla/Intel/solar/grid sources. |
| early intro | `40069a50` | Wade | UNVERIFIABLE | lance 0 / tavily 5 / grokipedia 0 | 5,615 | Entity poisoning: `Wade` should be Wayve. Tavily returned Wade financial/construction/bank results. |
| investment discussion | `4e37069e` | Twin AI | UNVERIFIABLE | lance 0 / tavily 5 / grokipedia 0 | 10,924 | Zod retry on grounding >40 words. Retrieved Nvidia autonomous-vehicle article but entity extraction appears wrong. |
| deployment discussion | `8c1ed76c` | Uber | PARTIAL | lance 0 / tavily 5 / grokipedia 0 | 5,875 | Good retrieval: TechCrunch and FT on Uber/Wayve/Nissan robotaxi launch. |
| competitive model discussion | `4c91044e` | Tesla | PARTIAL | lance 0 / tavily 5 / grokipedia 0 | 5,818 | Tesla vs Waymo claim. Retrieval included Reuters/TechCrunch robotaxi comparisons. |
| Waymo discussion | `ec6a727a` | Waymo | PARTIAL | lance 0 / tavily 5 / grokipedia 0 | 5,930 | Waymo CapEx/fleet claim. Tavily mixed weak sources with Reuters Waymo funding source. |
| Nissan technology discussion | `63b1585d` | Nissan | PARTIAL | lance 0 / tavily 5 / grokipedia 0 | 4,769 | Nissan technology-to-vehicles claim. Reuters source used, but query was broad. |
| Nissan FY2027 discussion | `9f545e00` | Nissan | PARTIAL | lance 0 / tavily 5 / grokipedia 0 | 4,636 | Similar Nissan technology claim; Reuters citation reused. |
| market-size math | `1264121a` | Tesla | PARTIAL | lance 0 / tavily 5 / grokipedia 0 | 8,447 | Zod retry on explanation >28 words. Entity likely wrong for 100M cars/year market-size math; Tesla sources were tangential. |
| closing logistics | `2b1a7e90` | WAVE | PARTIAL | lance 0 / tavily 5 / grokipedia 0 | 5,167 | Entity case/mishearing still retrieved Wayve/Uber/Nissan sources because query included Uber/London/Tokyo. |
| closing Nissan claim | `41fae8fc` | WAVE | FALSE | lance 0 / tavily 5 / grokipedia 0 | 5,591 | WAVE should be Wayve. Retrieval included correct TechCrunch Wayve/Nissan source despite alias issue. |
| closing Nissan claim | `1bbed95e` | WAVE | MISLEADING | lance 0 / tavily 5 / grokipedia 0 | 4,900 | WAVE should be Wayve. Query included Nissan partnership; TechCrunch source supported a more nuanced verdict. |

## Retrieval Health

### LanceDB

- LanceDB failed at startup warmup:
  - `Invalid input, No vector column found to match with the query vector dimension: 768`
- Every observed LanceDB retrieval returned `lance=0`.
- Circuit breaker opened repeatedly after five failures:
  - Opened during the NVIDIA/Qualcomm investment claim.
  - Reset after cooldown, then failed again on subsequent claims.
  - Opened again during Nissan, Wabi, and WAVE/Nissan sections.
- Impact: local cross-episode memory was unavailable for the whole pasted run. All rendered cards depended on Tavily only.
- Severity: blocking for archive-backed evidence; degrading for live web-only checks.

### Tavily

- Tavily was operational and typically returned 5 results when queries were specific.
- Query quality was the main determinant of usefulness:
  - Good: `"Uber" London Tokyo`, `"Tesla" Waymo`, `"Waymo" CapEx 2026`, `"WAVE" Uber London Tokyo`, `"WAVE" Nissan`.
  - Poor: `"Wade" UK`, `"Wave" Gaia Two Gaia Three released`, `"Wave" raised`, `"UN" The UN`, `"Tesla" revenue 2026`.
- Several non-empty retrievals still produced empty-citation UNVERIFIABLE outputs and render-policy suppression. This was usually correct when sources were tangential.

### Entity Poisoning Log

| Observed entity | Correct entity | Evidence | Effect |
| --- | --- | --- | --- |
| Wade | Wayve | `Wade is a UK based self driving startup...`; query `"Wade" UK` | Tavily returned Wade construction/financial/bank results. Rendered UNVERIFIABLE. |
| Wave | Wayve | `Wave released two new world models...`; query `"Wave" Gaia Two Gaia Three released` | Tavily returned Gaia/webb/SEC garbage. Render-policy suppressed. |
| Wave | Wayve | `Wave drove in 500 cities...`; query `"Wave"` | Tavily returned Wave financial/software company profiles. Render-policy suppressed. |
| Wave | Wayve | `Wave raised more than one billion dollars...`; query `"Wave" raised` | Tavily returned 0 results. Suppressed. |
| Wave | Wayve | `Wave has over 2,000,000,000 in capital...`; query `"Wave" 2026` | Tavily returned unrelated Wave company/IPO results. Suppressed. |
| Wabi | Waabi | `Wabi started in the world of self-driving trucks...`; query `"Wabi"` | Tavily returned 0 results. Suppressed. |
| WAVE | Wayve | `WAVE has fleets in London, Tokyo...`; query `"WAVE" London Tokyo Stuttgart 2026` | Tavily returned Reuters sitemap pages. Suppressed. |
| WAVE | Wayve | `WAVE will be callable on the Uber app...`; query `"WAVE" Uber London Tokyo` | Tavily recovered relevant Wayve/Uber/Nissan sources due to contextual query terms. Rendered PARTIAL. |
| WAVE | Wayve | `WAVE will offer cars... with Nissan`; query `"WAVE" Nissan` | Tavily found correct Wayve/Nissan source. Rendered FALSE. |
| WAVE | Wayve | `WAVE will sell cars... with Nissan`; query `"WAVE" Nissan partnership` | Tavily mixed weak sources with one relevant TechCrunch result. Rendered MISLEADING. |

## Classifier Performance

### Claims Detected But Dropped

Observed drop reasons:

- `empty_primary_entity`
  - Repeated for valid claims expressed as "the host's company", "the guest's company", "Speaker 2's organization", or generic market-size claims.
  - Examples:
    - `20,000 parameter world model in 2017`
    - `Gaia 2 and Gaia 3`
    - `over a dozen different companies sharing data`
    - `$1.215 billion` funding tranches
    - `100,000,000 vehicles produced each year`
    - `less than 10,000 robotaxis`
    - `100,000,000 cars per year at $1,000 per car`
    - `60 different car lines`
- `queue_dedupe`
  - Correctly deduped restatements for Uber/Nissan deployment, Tesla revenue, and UN legal pathway claims.
- `cooldown-fingerprint`
  - Correctly suppressed repeated claims for UN legal pathway and Tesla $100/month feature claims.
- Sponsor filter
  - Correctly filtered Render ad claims:
    - `5,000,000 developers are already using Render`
    - `$500 to $100,000 in free credits`
- `low_confidence`
  - One observed claim below threshold:
    - `The host's company had an end to end learning demo five years ago for AI driving.`
- `malformed_output`
  - Multiple malformed classifier JSON outputs occurred on Nissan 90%/2.7M-car claims and the `$1.215 billion` funding claim.

### Notable Correct Suppressions

- Opinions and strategy discussion without factual anchors were consistently suppressed.
- Hypothetical scenarios with explicit "making up numbers" language were suppressed.
- Product recommendations and promotional statements were usually suppressed.
- Render sponsor reads were caught by the sponsor filter.
- FDA/legal disclaimer style ad content was suppressed.

### Notable Missed Or Degraded Claims

- Wayve identity/funding/history claims were degraded by `Wade`, `Wave`, and `WAVE` transcription/entity extraction.
- Waabi truck-to-cars claim was degraded by `Wabi`.
- Funding claims around `$1.215 billion` were dropped due to empty primary entity or malformed classifier JSON.
- Broad market-size claims like `100,000,000 vehicles produced each year` were dropped because no primary entity was extracted.
- Nissan 90%/FY2027 claims often retrieved tangential Nissan corporate/Leaf/Formula E stories rather than the specific autonomous-driving announcement.

## Bugs and Issues Found

### 1. LanceDB 768-Dim Mismatch

- What happened:
  - Startup warmup failed with `No vector column found to match with the query vector dimension: 768`.
  - Every local memory query failed with the same error.
  - Circuit breaker opened repeatedly after 5 failures.
- Root cause:
  - The active embedding provider produced 768-dimensional vectors, but the LanceDB table does not expose a matching vector column.
- Severity: blocking for cross-episode memory; degrading for all verdicts that need archive evidence.
- Fix status: needs work.

### 2. Entity Alias Poisoning

- What happened:
  - Wayve was extracted as `Wade`, `Wave`, and `WAVE`.
  - Waabi was extracted as `Wabi`.
  - Queries using the poisoned entity returned irrelevant results or zero results.
- Root cause:
  - Deepgram proper-noun transcription plus classifier transcript-grounded entity extraction.
- Severity: blocking for core E2289 topic accuracy.
- Fix status: already started via `entityAliases.ts`; integration into classifier output path still needed.

### 3. Mismatched Tavily Citations

- What happened:
  - Tesla, Nissan, UN, and Wave queries often returned tangential sources.
  - Several non-empty retrievals ended as empty-citation UNVERIFIABLE and were suppressed.
- Root cause:
  - Query kernels over-weighted poisoned or broad entities and under-weighted the specific predicate.
- Severity: degrading.
- Fix status: needs work.

### 4. Speaker Label / Entity Resolution Issues

- What happened:
  - Claims referencing `the host's company`, `the guest's company`, or `Speaker 2's organization` were dropped for empty primary entity.
  - The classifier sometimes converted unresolved speaker references into generic claims without named entities.
- Root cause:
  - Classifier prompt intentionally refuses to infer entity names outside the transcript window.
- Severity: degrading.
- Fix status: needs work. Likely requires session dossier/context injection or safe alias/context map, not just prompt changes.

### 5. Empty Primary Entity Drops On Valid Claims

- What happened:
  - Valid numeric claims were dropped:
    - `100M vehicles produced each year`
    - `$1.215B funding`
    - `less than 10,000 robotaxis`
    - `100M cars/year * $1,000 = $100B`
- Root cause:
  - Gate stack requires a primary entity. Some valid market/statistical claims do not have one in the transcript window.
- Severity: degrading.
- Fix status: needs work. Consider allowing `metric`/`event` entity types through a separate retrieval path.

### 6. Zod Validation Retries

- What happened:
  - Docket retries occurred for:
    - Grounding >40 words on `Twin AI` investment card.
    - Grounding >40 words on `Wave has over 2B capital`.
    - Explanation >28 words on `$100B market value`.
- Root cause:
  - Model exceeded schema word limits.
- Severity: cosmetic to degrading. Retries increased TTFC, with one rendered card at 10,924 ms.
- Fix status: already partially handled by corrective retry; tune prompt if frequency rises.

### 7. Render-Policy Suppressions

- What happened:
  - Many non-empty Tavily retrievals ended as `UNVERIFIABLE with empty citations` and were suppressed.
- Root cause:
  - Retrieval returned tangential sources; Docket could not cite support.
- Severity: expected behavior, but degrading when upstream query/entity is wrong.
- Fix status: render policy is working; root fixes are entity aliases and retrieval query quality.

### 8. Malformed Classifier JSON

- What happened:
  - Classifier emitted truncated/malformed JSON for several high-value claims, including `$1.215B` funding and Nissan 90% technology adoption.
- Root cause:
  - Haiku output occasionally failed strict JSON completion.
- Severity: degrading.
- Fix status: needs work. Consider one corrective retry for malformed classifier output.

### 9. Clean Runtime Stability

- What happened:
  - No crashes, no Deepgram reconnects, no unhandled rejections in pasted log.
  - `SIGINT` shutdown drained cleanly.
- Root cause:
  - Recent reconnect/active-rollback/shutdown hardening appears effective in this run.
- Severity: positive finding.
- Fix status: no action.

## Recommendations

1. Fix LanceDB embedding/table dimension mismatch. Complexity: M.
2. Integrate entity alias normalization on classifier output for `claimText`, `primaryEntity`, and `searchableNoun` before gate stack/retrieval. Complexity: S.
3. Add context-aware entity resolution for episode guest/company so `host's company`, `guest's company`, and `Speaker N's organization` can resolve safely. Complexity: M.
4. Add a metric/statistical-claim path for valid claims with no named primary entity. Complexity: M.
5. Improve Tavily query construction to include predicate-specific terms and avoid broad entity-only queries. Complexity: M.
6. Add malformed-classifier-output retry before suppressing. Complexity: S.
7. Expand sponsor/ad blocklist for IM8/ultimate-essentials style reads and improve ad-read detection for health-product sponsor language. Complexity: S.
8. Track aggregate soak stats in process and emit a final summary on shutdown: segments, claims, drops by reason, retrieval attempts, broadcasts, verdict distribution, reconnects. Complexity: S.
9. Keep render-policy suppression unchanged; it prevented unsupported cards from rendering when retrieval was weak. Complexity: S.

