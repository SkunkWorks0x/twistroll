// Sentinel claim queue. Bridges classifier output to the retrieval layer and
// then the synthesis layer.
//
// Concurrency: 2 in-flight retrievals; overflow queues into a bounded
// pending list. Pending overflow evicts the lowest-value claim. Set
// CLAIM_QUEUE_MAX_PENDING=0 to disable pending and revert to drop-at-cap.
//
// Two dedup layers operate here:
//   1. Entity + claim-fingerprint cooldown (90s). Keyed on the normalized
//      entity; entries carry the normalized claim text, claimType, and
//      keyNumbers so distinct claims about the same entity (different type,
//      low text overlap) flow through. Registers on enqueue, not on
//      broadcast — a failed Docket run shouldn't open the door for a
//      restatement to burn another Docket call seconds later.
//   2. In-flight token-overlap dedup (10s rolling window, 0.8 threshold) on
//      primaryEntity / searchableNoun / keyNumbers — catches near-duplicate
//      windows the classifier didn't dedup before they reach retrieval.
//
// Layer (1) is documented inline at shouldCooldown.

import type { ClaimClassification, TranscriptSegment } from '../shared/types.js';
import { retrieve, RetrievalResult } from './retrieval.js';
import { recordStage } from './ttfcStages.js';

const MAX_CONCURRENCY = 2;
function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
const MAX_PENDING = envInt('CLAIM_QUEUE_MAX_PENDING', 10);
const DEDUP_WINDOW_MS = 10_000;
const ENTITY_OVERLAP_THRESHOLD = 0.8;
const ENTITY_COOLDOWN_MS = 90_000;

// claimType buckets we want to preserve under backpressure. Lower-value
// types (opinion, prediction, etc.) get evicted first when pending is full.
const VALUABLE_CLAIM_TYPES = new Set(['financial', 'historical', 'comparative']);

const GENERIC_TERMS = new Set(
  [
    'venture capital', 'series a', 'series b', 'series c', 'series d',
    'family offices', 'startups', 'investors', 'the market', 'the industry',
    'AI', 'VC',
    'companies', 'funds', 'founders', 'people', 'US firms', 'our firm',
    "guest's firm", 'LP base', 'AI company', 'breakout companies',
  ].map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
);

const SPONSOR_NAMES_RAW = [
  'sentry', 'render', 'deel', 'plaud', 'plaud.ai', 'plaid note', 'im8 health', 'im8',
  'lemon.io', 'linkedin', 'northwest registered agent', 'northwest',
  'squarespace', 'vanta', 'google cloud', 'hubspot', 'gusto', 'gamma',
  'netsuite', 'agree', 'grasshopper', 'grasshopper bank',
];
const SPONSOR_NAMES = new Set(
  SPONSOR_NAMES_RAW.map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
);
// Substring-match list: normalized entries ≥8 chars only. Catches compound
// product names ("Plaid note pen" against "plaid note") that exact match
// would miss, while keeping short single-word sponsors ('deel', 'gusto')
// on exact match so they don't false-positive on unrelated tokens.
const SPONSOR_NAME_PREFIXES = SPONSOR_NAMES_RAW
  .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
  .filter((s) => s.length >= 8);

// Sponsor-read phrase detection — catches reads with non-blocklisted entities
// (e.g., Twist promo-code reads). Conservative pattern: requires a strong
// sponsor-specific signal (promo code, use/with code + word, cash bonus, or
// explicit "brought to you by" / "sponsored by"). Does NOT match generic
// "partner", "save", or "twist" alone — those have legitimate uses in
// banking/startup discussion.
const SPONSOR_PHRASE_RE = /promo code|(use|using|enter|with) (the )?code \w+|cash bonus|sponsored by|brought to you by/i;

function normalizeEntity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Entity + claim-fingerprint cooldown ───────────────────────────────

type CooldownEntry = {
  entity: string;
  claimType: string | undefined;
  normalizedClaim: string;
  keyNumbers: string[];
  expiresAt: number;
};

const cooldownsByEntity = new Map<string, CooldownEntry[]>();

function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s.$%-]/g, ' ')
    .replace(/\b(the|a|an|is|are|was|were|has|have|had|said|says|that|this|it)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenJaccard(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter((w) => w.length > 3));
  const setB = new Set(b.split(' ').filter((w) => w.length > 3));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

// Predicate buckets — synonym families that collapse opinion/assessment claims
// into a small set of qualitative directions. Used by the empty-keyNumbers
// fallback in shouldCooldown so "X is behind in Y" and "X is lagging in Y"
// resolve to the same bucket (suppress as restatement), while "X is behind"
// and "X has unbeatable distribution" don't (different buckets, allow).
const PREDICATE_FAMILIES: Record<string, string[]> = {
  lagging: ['behind', 'lagging', 'late', 'catching', 'furthest', 'losing'],
  leading: ['leading', 'ahead', 'dominant', 'winning', 'best'],
  weak: ['bad', 'weak', 'poor', 'worse', 'inferior', 'struggling'],
  strong: ['good', 'strong', 'great', 'better', 'superior', 'impressive'],
  risk: ['risky', 'mistake', 'misstep', 'unstable', 'chaos', 'exposed'],
  advantage: ['advantage', 'moat', 'distribution', 'ecosystem', 'unbeatable'],
  dependent: ['dependent', 'relies', 'needs', 'powered', 'built'],
};

function predicateBucket(normalizedText: string): string | null {
  const words = normalizedText.split(' ');
  for (const [bucket, keywords] of Object.entries(PREDICATE_FAMILIES)) {
    if (keywords.some((kw) => words.includes(kw))) return bucket;
  }
  return null;
}

// Read-only — mutation lives in registerCooldown so a claim dropped after
// this check doesn't poison the map against the next legitimate claim.
function checkCooldown(claim: ClaimClassification, now = Date.now()): boolean {
  const entity = normalizeEntity(claim.primaryEntity);
  const entries = (cooldownsByEntity.get(entity) ?? []).filter((e) => e.expiresAt > now);
  const normalized = normalizeClaimText(claim.claimText);

  for (const entry of entries) {
    const sameClaimType = entry.claimType === claim.claimType;
    const overlap = tokenJaccard(normalized, entry.normalizedClaim);

    if (sameClaimType && overlap >= 0.72) return true;
    if (overlap >= 0.85) return true;

    // Short opinion/assessment restatements with no numeric anchors —
    // matched via predicate-family bucket (synonym collapse). Unknown
    // predicates (null bucket) pass through and are not suppressed.
    const bothNoNumbers = (entry.keyNumbers.length === 0) && ((claim.keyNumbers ?? []).length === 0);
    if (sameClaimType && bothNoNumbers) {
      const entryPred = predicateBucket(entry.normalizedClaim);
      const claimPred = predicateBucket(normalizeClaimText(claim.claimText));
      if (entryPred !== null && entryPred === claimPred) return true;
    }
  }
  return false;
}

function registerCooldown(claim: ClaimClassification, now = Date.now()): void {
  const entity = normalizeEntity(claim.primaryEntity);
  const normalized = normalizeClaimText(claim.claimText);
  const entries = (cooldownsByEntity.get(entity) ?? []).filter((e) => e.expiresAt > now);
  entries.push({
    entity,
    claimType: claim.claimType,
    normalizedClaim: normalized,
    keyNumbers: claim.keyNumbers ?? [],
    expiresAt: now + ENTITY_COOLDOWN_MS,
  });
  cooldownsByEntity.set(entity, entries);
}

// ─── In-flight token-overlap dedup (10s window) ────────────────────────

interface ProcessedRecord {
  entities: Set<string>;
  processedAt: number;
}
const recentlyProcessed: ProcessedRecord[] = [];
let activeCount = 0;

interface PendingEntry {
  claim: ClaimClassification;
  segmentSnapshot: TranscriptSegment[];
  enqueuedAt: number;
}
const pending: PendingEntry[] = [];

let droppedConcurrency = 0;
let droppedBackpressure = 0;
let processed = 0;
let suppressedDedup = 0;

function claimValueScore(entry: PendingEntry): number {
  const { claim, enqueuedAt } = entry;
  // Scaled buckets so confidence (0..1 × 10_000) deltas dominate the
  // enqueuedAt tiebreaker (~0.17 magnitude for Date.now() / 1e13).
  // Pre-fix the deltas could collide; now keyNumbers > type > confidence >
  // age is strictly ordered for any sub-percent confidence delta.
  let score = 0;
  if (claim.keyNumbers && claim.keyNumbers.length > 0) score += 1_000_000;
  if (claim.claimType && VALUABLE_CLAIM_TYPES.has(claim.claimType)) score += 100_000;
  score += claim.confidence * 10_000;
  score += enqueuedAt / 1e13;
  return score;
}

function lowestValueIndex(entries: PendingEntry[]): number {
  let minIdx = 0;
  let minScore = claimValueScore(entries[0]);
  for (let i = 1; i < entries.length; i++) {
    const s = claimValueScore(entries[i]);
    if (s < minScore) {
      minScore = s;
      minIdx = i;
    }
  }
  return minIdx;
}

function extractEntities(claim: ClaimClassification): Set<string> {
  const tokens = new Set<string>();
  const blob = [claim.primaryEntity, claim.searchableNoun, ...(claim.keyNumbers || [])]
    .filter(Boolean)
    .join(' ');
  for (const w of blob.toLowerCase().split(/\W+/)) {
    if (w.length >= 3) tokens.add(w);
  }
  return tokens;
}

function entityOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const e of a) if (b.has(e)) intersect++;
  return intersect / Math.min(a.size, b.size);
}

function pruneOldRecords(): void {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  while (recentlyProcessed.length > 0 && recentlyProcessed[0].processedAt < cutoff) {
    recentlyProcessed.shift();
  }
}

// shouldCooldown filters lazily on read, so an entity mentioned once and
// never again retains its stale entries forever. Walk the map periodically
// to evict them. Throttled by COOLDOWN_PRUNE_INTERVAL_MS.
const COOLDOWN_PRUNE_INTERVAL_MS = 30_000;
let lastCooldownPruneAt = 0;

function pruneCooldowns(now = Date.now()): void {
  if (now - lastCooldownPruneAt < COOLDOWN_PRUNE_INTERVAL_MS) return;
  lastCooldownPruneAt = now;
  for (const [entity, entries] of cooldownsByEntity) {
    const live = entries.filter((e) => e.expiresAt > now);
    if (live.length === 0) cooldownsByEntity.delete(entity);
    else if (live.length !== entries.length) cooldownsByEntity.set(entity, live);
  }
}

export interface QueueProcessResult {
  claim: ClaimClassification;
  segmentSnapshot: TranscriptSegment[];
  retrieval: RetrievalResult;
}

export type QueueProcessHandler = (result: QueueProcessResult) => void | Promise<void>;

export interface EnqueueResult {
  enqueued: boolean;
  reason?: string;
}

let processHandler: QueueProcessHandler | null = null;

export function setProcessHandler(handler: QueueProcessHandler | null): void {
  processHandler = handler;
}

// Notified when a claim leaves the pending queue and enters the retrieve()
// call. Distinct from process_handler (post-retrieval) so the dashboard can
// surface a 'retrieving' progress event with no information leak.
export type RetrievalStartHandler = (claim: ClaimClassification) => void;
let retrievalStartHandler: RetrievalStartHandler | null = null;
export function setRetrievalStartHandler(handler: RetrievalStartHandler | null): void {
  retrievalStartHandler = handler;
}

export function enqueueClaim(
  claim: ClaimClassification,
  recentSegments: TranscriptSegment[]
): EnqueueResult {
  pruneOldRecords();
  pruneCooldowns();

  // Empty / whitespace primaryEntity → drop. Without an entity anchor the
  // retrieval discriminator can't build a useful Tavily query and the Docket
  // has nothing to triangulate against; downstream cards consistently end up
  // null or UNVERIFIABLE-without-citations on these claims.
  if (!claim.primaryEntity || !claim.primaryEntity.trim()) {
    console.log('[QUEUE] Dropped: empty primaryEntity');
    console.log(`[classifier-suppress] reason=empty_primary_entity claimText="${claim.claimText.slice(0, 50)}"`);
    return { enqueued: false, reason: 'empty primaryEntity' };
  }

  const normEntity = normalizeEntity(claim.primaryEntity);
  if (SPONSOR_NAMES.has(normEntity) || SPONSOR_NAME_PREFIXES.some((p) => normEntity.includes(p))) {
    console.log(`[queue-filter] sponsor-read: "${claim.primaryEntity}"`);
    return { enqueued: false, reason: 'sponsor read' };
  }
  if (SPONSOR_PHRASE_RE.test(claim.claimText)) {
    console.log(`[queue-filter] sponsor-phrase: "${claim.claimText.slice(0, 60)}"`);
    return { enqueued: false, reason: 'sponsor phrase' };
  }
  // Adjacent-segment sponsor-phrase check — sponsor reads commonly span
  // multiple segments where the trigger phrase ("use the code X", "promo
  // code", etc.) sits in one segment and the product-feature sentence the
  // classifier extracted sits in another. Scan the recent-segment buffer so
  // the gate catches the product-description half too.
  for (const seg of recentSegments) {
    if (SPONSOR_PHRASE_RE.test(seg.text)) {
      console.log(`[queue-filter] sponsor-phrase-context: claim="${claim.claimText.slice(0, 60)}" trigger="${seg.text.slice(0, 60)}"`);
      return { enqueued: false, reason: 'sponsor phrase (recent context)' };
    }
  }

  const tokenCount = claim.primaryEntity.trim().split(/\s+/).length;
  if (/^Speaker \d+$/i.test(claim.primaryEntity.trim())) {
    console.log(`[queue-filter] weak-entity: "${claim.primaryEntity}" (reason: speaker_label)`);
    return { enqueued: false, reason: 'weak entity (speaker label)' };
  }
  if (tokenCount === 1 && claim.entityType === 'person') {
    console.log(`[queue-filter] weak-entity: "${claim.primaryEntity}" (reason: single_token)`);
    return { enqueued: false, reason: 'weak entity (single-token person)' };
  }
  if (GENERIC_TERMS.has(normEntity)) {
    console.log(`[queue-filter] weak-entity: "${claim.primaryEntity}" (reason: generic_term)`);
    return { enqueued: false, reason: 'weak entity (generic term)' };
  }

  if (checkCooldown(claim)) {
    suppressedDedup++;
    console.log(`[queue-dedup] cooldown-fingerprint: "${claim.primaryEntity}" claimType=${claim.claimType ?? 'unknown'}`);
    return { enqueued: false, reason: 'entity+fingerprint cooldown' };
  }

  const incoming = extractEntities(claim);
  for (const rec of recentlyProcessed) {
    const overlap = entityOverlap(incoming, rec.entities);
    if (overlap > ENTITY_OVERLAP_THRESHOLD) {
      suppressedDedup++;
      console.log(`[QUEUE] Deduped: ${claim.claimText}`);
      console.log(`[classifier-suppress] reason=queue_dedupe entity="${claim.primaryEntity}"`);
      return { enqueued: false, reason: `entity overlap ${overlap.toFixed(2)}` };
    }
  }

  // Snapshot segments at fire time so processing sees what was true when
  // the classifier emitted, not what's true after the retrieval round-trip.
  const segmentSnapshot = recentSegments.slice(-12);

  if (activeCount < MAX_CONCURRENCY) {
    recentlyProcessed.push({ entities: incoming, processedAt: Date.now() });
    registerCooldown(claim);
    startProcessing(claim, segmentSnapshot);
    return { enqueued: true };
  }

  // MAX_PENDING=0 reverts to legacy drop-at-cap so droppedConcurrency
  // stays meaningful as a knob.
  if (MAX_PENDING <= 0) {
    droppedConcurrency++;
    console.warn(`[QUEUE] Concurrency cap (${MAX_CONCURRENCY}) reached; pending disabled — dropping: ${claim.claimText.slice(0, 50)}`);
    console.log(`[classifier-suppress] reason=concurrency_cap claimText="${claim.claimText.slice(0, 50)}"`);
    return { enqueued: false, reason: 'concurrency cap (pending disabled)' };
  }

  const newEntry: PendingEntry = { claim, segmentSnapshot, enqueuedAt: Date.now() };

  if (pending.length >= MAX_PENDING) {
    // Score the newcomer alongside existing pending so it can lose to itself
    // rather than displace a better-scored claim.
    const candidates = [...pending, newEntry];
    const evictIdx = lowestValueIndex(candidates);
    droppedBackpressure++;
    if (evictIdx === pending.length) {
      console.warn(`[QUEUE] Pending full (${MAX_PENDING}); newcomer is lowest value — dropping: ${claim.claimText.slice(0, 50)}`);
      return { enqueued: false, reason: 'backpressure (newcomer lowest value)' };
    }
    const [evicted] = pending.splice(evictIdx, 1);
    console.warn(`[QUEUE] Pending full (${MAX_PENDING}); evicting lowest-value pending: ${evicted.claim.claimText.slice(0, 50)}`);
  }

  recentlyProcessed.push({ entities: incoming, processedAt: Date.now() });
  registerCooldown(claim);
  pending.push(newEntry);
  return { enqueued: true, reason: 'queued (pending)' };
}

function startProcessing(claim: ClaimClassification, segmentSnapshot: TranscriptSegment[]): void {
  activeCount++;
  void (async () => {
    try {
      recordStage(claim.segmentId, 'retrievalStartMs', Date.now());
      if (retrievalStartHandler) {
        try { retrievalStartHandler(claim); } catch { /* never crash retrieval on a handler bug */ }
      }
      const retrieval = await retrieve(claim);
      recordStage(claim.segmentId, 'retrievalEndMs', Date.now());
      const lanceTitles = retrieval.lance.map((s) => s.title).join('; ') || '(none)';
      const tavilyTitles = retrieval.tavily.map((s) => s.title).join('; ') || '(none)';
      const grokTitles = retrieval.grokipedia.map((s) => s.title).join('; ') || '(none)';
      console.log(
        `[QUEUE] retrieval done for "${claim.claimText.slice(0, 60)}…": ` +
        `lance=${retrieval.lance.length} (${lanceTitles}), ` +
        `tavily=${retrieval.tavily.length} (${tavilyTitles}), ` +
        `grokipedia=${retrieval.grokipedia.length} (${grokTitles}), ` +
        `merged=${retrieval.merged.length}, total=${retrieval.timing.total}ms`
      );
      if (processHandler) {
        await processHandler({ claim, segmentSnapshot, retrieval });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[QUEUE] processing failed: ${msg}`);
    } finally {
      activeCount--;
      processed++;
      drainPending();
    }
  })();
}

function drainPending(): void {
  while (activeCount < MAX_CONCURRENCY && pending.length > 0) {
    const next = pending.shift()!;
    startProcessing(next.claim, next.segmentSnapshot);
  }
}

export function queueStats() {
  pruneOldRecords();
  pruneCooldowns();
  return {
    active: activeCount,
    pending: pending.length,
    droppedConcurrency,
    droppedBackpressure,
    processed,
    suppressedDedup,
    recentlyProcessedCount: recentlyProcessed.length,
    maxConcurrency: MAX_CONCURRENCY,
    maxPending: MAX_PENDING,
    dedupWindowMs: DEDUP_WINDOW_MS,
  };
}
