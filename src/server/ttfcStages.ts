type Stages = {
  classifierEndMs: number;
  retrievalStartMs: number;
  retrievalEndMs: number;
  synthesisEndMs: number;
  broadcastSendMs: number;
};

const MAX = 256;
const map = new Map<string, Partial<Stages>>();

export function recordStage(claimId: string, key: keyof Stages, ms: number): void {
  if (!map.has(claimId) && map.size >= MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  const entry = map.get(claimId) ?? {};
  entry[key] = ms;
  map.set(claimId, entry);
}

export function getStages(claimId: string): Partial<Stages> | undefined {
  return map.get(claimId);
}

export function dropStages(claimId: string): void {
  map.delete(claimId);
}
