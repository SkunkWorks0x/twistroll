// Sentinel claim queue. Bridges classifier output to the retrieval layer (and,
// in CC Prompt 5, to the synthesis layer).
//
// Concurrency cap: 2 in-flight retrievals. Bypasses cap → drop with a log so
// the failure mode is visible.
//
// Entity-based dedup: incoming claim's lowercased tokens (from primaryEntity,
// keyNumbers, searchableNoun) are compared against claims processed in the
// last 10s. Overlap > 0.8 = skip. Prevents the same claim from re-firing
// across overlapping windows the classifier didn't dedup.

import type { ClaimClassification, TranscriptSegment } from '../shared/types.js';
import { retrieve, RetrievalResult } from './retrieval.js';
import { recordStage } from './ttfcStages.js';

const MAX_CONCURRENCY = 2;
const DEDUP_WINDOW_MS = 10_000;
const ENTITY_OVERLAP_THRESHOLD = 0.8;
const ENTITY_COOLDOWN_MS = 90_000;

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

const lastBroadcastByEntity = new Map<string, number>();

function normalizeEntity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function recordBroadcast(entity: string): void {
  if (!entity) return;
  lastBroadcastByEntity.set(normalizeEntity(entity), Date.now());
}

interface ProcessedRecord {
  entities: Set<string>;
  processedAt: number;
}
const recentlyProcessed: ProcessedRecord[] = [];
let activeCount = 0;

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

  const lastBroadcast = lastBroadcastByEntity.get(normEntity);
  if (lastBroadcast !== undefined) {
    const elapsed = Date.now() - lastBroadcast;
    if (elapsed < ENTITY_COOLDOWN_MS) {
      console.log(`[queue-dedup] entity-cooldown: ${claim.primaryEntity} (last card ${elapsed}ms ago)`);
      return { enqueued: false, reason: `entity cooldown ${elapsed}ms` };
    }
  }

  const incoming = extractEntities(claim);
  for (const rec of recentlyProcessed) {
    const overlap = entityOverlap(incoming, rec.entities);
    if (overlap > ENTITY_OVERLAP_THRESHOLD) {
      console.log(`[QUEUE] Deduped: ${claim.claimText}`);
      console.log(`[classifier-suppress] reason=queue_dedupe entity="${claim.primaryEntity}"`);
      return { enqueued: false, reason: `entity overlap ${overlap.toFixed(2)}` };
    }
  }

  if (activeCount >= MAX_CONCURRENCY) {
    console.warn(`[QUEUE] Concurrency cap (${MAX_CONCURRENCY}) reached — dropping claim: ${claim.claimText}`);
    console.log(`[classifier-suppress] reason=concurrency_cap claimText="${claim.claimText.slice(0, 50)}"`);
    return { enqueued: false, reason: 'concurrency cap' };
  }

  recentlyProcessed.push({ entities: incoming, processedAt: Date.now() });
  activeCount++;

  // Snapshot segments at fire time so processing sees what was true when
  // the classifier emitted, not what's true after the retrieval round-trip.
  const segmentSnapshot = recentSegments.slice(-12);

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
    }
  })();

  return { enqueued: true };
}

export function queueStats() {
  pruneOldRecords();
  return {
    active: activeCount,
    recentlyProcessedCount: recentlyProcessed.length,
    maxConcurrency: MAX_CONCURRENCY,
    dedupWindowMs: DEDUP_WINDOW_MS,
  };
}
