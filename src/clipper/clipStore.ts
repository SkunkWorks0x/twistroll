import * as lancedb from '@lancedb/lancedb';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ClipCandidate, ClipStatus } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '..', '..', 'data', 'lance-db');
const TABLE_NAME = 'clip_candidates';

let conn: lancedb.Connection | null = null;
let table: lancedb.Table | null = null;

// Small dummy vector so LanceDB can infer schema. Not used for similarity.
const DUMMY_VECTOR_DIM = 8;
const zeroVector = (): number[] => new Array(DUMMY_VECTOR_DIM).fill(0);

export async function initClipStore(): Promise<lancedb.Table> {
  if (table) return table;
  if (!existsSync(DB_PATH)) mkdirSync(DB_PATH, { recursive: true });
  conn = await lancedb.connect(DB_PATH);

  const names = await conn.tableNames();
  if (names.includes(TABLE_NAME)) {
    table = await conn.openTable(TABLE_NAME);
    return table;
  }

  const seed: ClipCandidate = {
    id: '__seed__',
    centerTimestamp: 0,
    episodeNumber: 0,
    score: 0,
    scoreBreakdown: '{}',
    metadata: '{}',
    status: 'pending',
    createdAt: 0,
    videoHook: '',
    videoShorts: '',
    videoExtended: '',
    rejectReason: '',
    transcript: '',
    reactionCount: 0,
    vector: zeroVector(),
  };
  table = await conn.createTable(
    TABLE_NAME,
    [seed] as unknown as Record<string, unknown>[],
    { mode: 'create' }
  );
  await table.delete("id = '__seed__'");
  return table;
}

export async function insertClip(
  clip: Omit<ClipCandidate, 'vector'>
): Promise<void> {
  const tbl = await initClipStore();
  const row: ClipCandidate = { ...clip, vector: zeroVector() };
  await tbl.add([row] as unknown as Record<string, unknown>[]);
}

export async function listClips(statusFilter?: ClipStatus): Promise<ClipCandidate[]> {
  const tbl = await initClipStore();
  let q = tbl.query().limit(1000);
  if (statusFilter) {
    q = q.where(`status = '${statusFilter}'`);
  }
  const rows = await q.toArray();
  return rows as unknown as ClipCandidate[];
}

export async function listAllClips(): Promise<ClipCandidate[]> {
  const tbl = await initClipStore();
  const rows = await tbl.query().limit(1000).toArray();
  return rows as unknown as ClipCandidate[];
}

export async function updateClipStatus(
  id: string,
  status: ClipStatus,
  rejectReason: string = ''
): Promise<boolean> {
  const tbl = await initClipStore();
  const existing = await tbl
    .query()
    .where(`id = '${id.replace(/'/g, "''")}'`)
    .limit(1)
    .toArray();
  if (existing.length === 0) return false;
  const row = existing[0] as unknown as ClipCandidate;
  await tbl.delete(`id = '${id.replace(/'/g, "''")}'`);
  row.status = status;
  row.rejectReason = rejectReason;
  row.vector = zeroVector();
  await tbl.add([row] as unknown as Record<string, unknown>[]);
  return true;
}

export async function clipExists(id: string): Promise<boolean> {
  const tbl = await initClipStore();
  const existing = await tbl
    .query()
    .where(`id = '${id.replace(/'/g, "''")}'`)
    .limit(1)
    .toArray();
  return existing.length > 0;
}
