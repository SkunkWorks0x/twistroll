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
const MAX_PENDING = parseInt(process.env.CLAIM_QUEUE_MAX_PENDING || '10', 10);
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

const SPONSOR_NAMES = new Set(
  [
    'sentry', 'render', 'deel', 'plaud', 'im8 health', 'im8', 'lemon.io',
    'linkedin', 'northwest registered agent', 'northwest', 'squarespace',
    'vanta', 'google cloud', 'hubspot', 'gusto', 'gamma', 'netsuite', 'agree',
  ].map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
);

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

function shouldCooldown(claim: ClaimClassification, now = Date.now()): boolean {
  const entity = normalizeEntity(claim.primaryEntity);
  const entries = (cooldownsByEntity.get(entity) ?? []).filter((e) => e.expiresAt > now);

  const normalized = normalizeClaimText(claim.claimText);

  for (const entry of entries) {
    const sameClaimType = entry.claimType === claim.claimType;
    const overlap = tokenJaccard(normalized, entry.normalizedClaim);

    // Same entity + same claim type + high text overlap = suppress (restatement)
    if (sameClaimType && overlap >= 0.72) return true;

    // Same entity + very high text overlap regardless of claim type = suppress
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

  // Not suppressed — register this claim in cooldown.
  entries.push({
    entity,
    claimType: claim.claimType,
    normalizedClaim: normalized,
    keyNumbers: claim.keyNumbers ?? [],
    expiresAt: now + ENTITY_COOLDOWN_MS,
  });
  cooldownsByEntity.set(entity, entries);
  return false;
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
  let score = 0;
  if (claim.keyNumbers && claim.keyNumbers.length > 0) score += 1000;
  if (claim.claimType && VALUABLE_CLAIM_TYPES.has(claim.claimType)) score += 100;
  score += claim.confidence * 10;
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

export function enqueueClaim(
  claim: ClaimClassification,
  recentSegments: TranscriptSegment[]
): EnqueueResult {
  pruneOldRecords();

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
  if (SPONSOR_NAMES.has(normEntity)) {
    console.log(`[queue-filter] sponsor-read: "${claim.primaryEntity}"`);
    return { enqueued: false, reason: 'sponsor read' };
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

  if (shouldCooldown(claim)) {
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
  pending.push(newEntry);
  return { enqueued: true, reason: 'queued (pending)' };
}

function startProcessing(claim: ClaimClassification, segmentSnapshot: TranscriptSegment[]): void {
  activeCount++;
  void (async () => {
    try {
      recordStage(claim.segmentId, 'retrievalStartMs', Date.now());
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
