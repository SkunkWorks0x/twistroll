type Stages = {
  classifierEndMs: number;
  retrievalStartMs: number;
  retrievalEndMs: number;
  synthesisEndMs: number;
  broadcastSendMs: number;
};

interface Entry {
  stages: Partial<Stages>;
  insertedAt: number;
}

const MAX = 256;
const TTL_MS = 5 * 60 * 1000;
const map = new Map<string, Entry>();

// Iteration is insertion-ordered, so first non-expired ends the scan.
function pruneExpired(now: number): void {
  for (const [k, e] of map) {
    if (now - e.insertedAt > TTL_MS) map.delete(k);
    else break;
  }
}

export function recordStage(claimId: string, key: keyof Stages, ms: number): void {
  const now = Date.now();
  pruneExpired(now);
  const existing = map.get(claimId);
  if (existing) {
    existing.stages[key] = ms;
    return;
  }
  if (map.size >= MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(claimId, { stages: { [key]: ms }, insertedAt: now });
}

export function getStages(claimId: string): Partial<Stages> | undefined {
  const e = map.get(claimId);
  if (!e) return undefined;
  if (Date.now() - e.insertedAt > TTL_MS) {
    map.delete(claimId);
    return undefined;
  }
  return e.stages;
}

export function dropStages(claimId: string): void {
  map.delete(claimId);
}

export function clearAllStages(): void {
  map.clear();
}
