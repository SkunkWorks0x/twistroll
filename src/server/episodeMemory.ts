import * as lancedb from '@lancedb/lancedb';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DB_PATH = resolve(__dirname, '..', '..', 'data', 'lance-db');
export const TABLE_NAME = 'episodes';
export const EMBED_MODEL = 'embeddinggemma';
export const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';

export interface EpisodeChunk {
  id: string;
  vector: number[];
  text: string;
  episodeNumber: number | null;
  episodeDate: string;
  episodeTitle: string;
  guestName: string;
  topicTags: string[];
  startTimestamp: number;
  chunkIndex: number;
  provisional: boolean;
  sessionFile: string | null;
}

export interface IngestMetadata {
  episodeNumber: number | null;
  episodeDate: string;
  episodeTitle: string;
  guestName: string;
  topicTags: string[];
  transcriptText: string;
  startTimestamp: number;
  provisional?: boolean;
  sessionFile?: string | null;
}

export interface MemoryQueryResult {
  text: string;
  episodeNumber: number;
  episodeDate: string;
  episodeTitle: string;
  guestName: string;
  score: number;
}

let connection: lancedb.Connection | null = null;
let table: lancedb.Table | null = null;

/**
 * Open or create the LanceDB connection and episodes table.
 * Safe to call multiple times — caches the connection.
 */
export async function initMemory(): Promise<lancedb.Table> {
  if (table) return table;

  if (!existsSync(DB_PATH)) {
    mkdirSync(DB_PATH, { recursive: true });
  }

  connection = await lancedb.connect(DB_PATH);

  const tableNames = await connection.tableNames();
  if (tableNames.includes(TABLE_NAME)) {
    table = await connection.openTable(TABLE_NAME);
    return table;
  }

  // Probe embedding dim so the vector column is correctly sized.
  const probe = await embedText('probe');
  // sessionFile uses empty string as null sentinel — LanceDB can't infer type from null.
  const seed: EpisodeChunk = {
    id: '__seed__',
    vector: probe,
    text: '',
    episodeNumber: 0,
    episodeDate: '',
    episodeTitle: '',
    guestName: '',
    topicTags: ['__seed__'],
    startTimestamp: 0,
    chunkIndex: 0,
    provisional: true,
    sessionFile: '' as any,
  };

  table = await connection.createTable(TABLE_NAME, [seed] as unknown as Record<string, unknown>[], { mode: 'create' });
  // Delete the seed row so the table is effectively empty but schema is locked.
  await table.delete("id = '__seed__'");
  return table;
}

/**
 * Embed text via Ollama's embeddinggemma model.
 */
export async function embedText(text: string): Promise<number[]> {
  const res = await fetch(OLLAMA_EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { embedding?: number[] };
  if (!json.embedding || !Array.isArray(json.embedding)) {
    throw new Error('Ollama embeddings response missing "embedding" field');
  }
  return json.embedding;
}

/**
 * Word-based sliding-window chunker. Approximates token chunking.
 */
export function chunkTranscript(
  transcript: string,
  chunkSize: number = 600,
  overlap: number = 150
): string[] {
  const words = transcript.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  if (words.length <= chunkSize) return [words.join(' ')];

  const step = Math.max(1, chunkSize - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += step) {
    const slice = words.slice(start, start + chunkSize);
    chunks.push(slice.join(' '));
    if (start + chunkSize >= words.length) break;
  }
  return chunks;
}

/**
 * Chunk + embed + insert an episode's transcript into LanceDB.
 * Returns the number of chunks inserted.
 */
export async function ingestEpisode(metadata: IngestMetadata): Promise<number> {
  const tbl = await initMemory();
  const chunks = chunkTranscript(metadata.transcriptText);
  if (chunks.length === 0) return 0;

  // Upsert: delete any existing chunks for this episode first (backfill path only).
  if (metadata.episodeNumber != null) {
    const existing = await tbl
      .query()
      .where(`episodeNumber = ${metadata.episodeNumber}`)
      .limit(100000)
      .toArray()
      .catch(() => [] as unknown[]);
    if (existing.length > 0) {
      await tbl.delete(`episodeNumber = ${metadata.episodeNumber}`);
      console.log(`[ingest] Replaced ${existing.length} existing chunks for Ep ${metadata.episodeNumber}`);
    }
  }

  const provisional = metadata.provisional ?? true;
  // Empty string as null sentinel — LanceDB can't store typed nulls without explicit Arrow schema.
  const sessionFile = metadata.sessionFile || '';

  const rows: EpisodeChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const vector = await embedText(chunks[i]);
    const idPrefix = metadata.episodeNumber != null ? `ep_${metadata.episodeNumber}` : `live_${(sessionFile || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    rows.push({
      id: `${idPrefix}_chunk_${i}`,
      vector,
      text: chunks[i],
      episodeNumber: metadata.episodeNumber,
      episodeDate: metadata.episodeDate,
      episodeTitle: metadata.episodeTitle,
      guestName: metadata.guestName,
      topicTags: metadata.topicTags,
      startTimestamp: metadata.startTimestamp,
      chunkIndex: i,
      provisional,
      sessionFile,
    });
  }

  await tbl.add(rows as unknown as Record<string, unknown>[]);
  return rows.length;
}

/**
 * Embed a query and run a LanceDB similarity search with optional metadata filter.
 */
export async function queryMemory(
  queryText: string,
  topK: number = 5,
  filter?: { guestName?: string; sinceDate?: string }
): Promise<MemoryQueryResult[]> {
  const tbl = await initMemory();
  const qVec = await embedText(queryText);

  // EmbeddingGemma L2-normalizes outputs, so dot product == cosine similarity.
  // LanceDB's 'dot' metric returns `_distance = 1 - dot_product`, so score = 1 - _distance
  // gives us cosine similarity in a clean 0..1 range (higher = better).
  let q = (tbl.search(qVec) as lancedb.VectorQuery).distanceType('dot').limit(topK);

  const clauses: string[] = ['provisional = false'];
  if (filter?.guestName) {
    clauses.push(`guestName = '${filter.guestName.replace(/'/g, "''")}'`);
  }
  if (filter?.sinceDate) {
    clauses.push(`episodeDate >= '${filter.sinceDate.replace(/'/g, "''")}'`);
  }
  q = q.where(clauses.join(' AND '));

  const raw = await q.toArray();
  const scored: MemoryQueryResult[] = raw.map((r: any) => ({
    text: r.text,
    episodeNumber: r.episodeNumber,
    episodeDate: r.episodeDate,
    episodeTitle: r.episodeTitle,
    guestName: r.guestName,
    score: typeof r._distance === 'number' ? 1 - r._distance : 0,
  }));

  return findRelevantResults(scored);
}

/**
 * Gap-detection filter. Keeps results above a hard floor, then cuts at the
 * largest score cliff if it's big enough (>10% of the best score). This
 * catches the natural drop between "actually relevant" and "noise".
 */
export function findRelevantResults(
  results: MemoryQueryResult[],
  minFloor: number = 0.46
): MemoryQueryResult[] {
  if (results.length === 0) return [];
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const aboveFloor = sorted.filter((r) => r.score >= minFloor);
  if (aboveFloor.length === 0) {
    console.log(`[memory] 0 results above floor (${minFloor}) of ${sorted.length} candidates`);
    return [];
  }

  let largestGapIdx = aboveFloor.length;
  let largestGap = 0;
  for (let i = 0; i < aboveFloor.length - 1; i++) {
    const gap = aboveFloor[i].score - aboveFloor[i + 1].score;
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIdx = i + 1;
    }
  }

  const gapThreshold = aboveFloor[0].score * 0.10;
  const cut = largestGap > gapThreshold ? aboveFloor.slice(0, largestGapIdx) : aboveFloor;
  console.log(
    `[memory] ${aboveFloor.length} results above floor, ${cut.length} after gap detection (largest gap=${largestGap.toFixed(4)}, threshold=${gapThreshold.toFixed(4)})`
  );
  return cut;
}

/**
 * Flip all provisional chunks for a given session to committed (provisional=false).
 * Returns the number of chunks flipped.
 */
export async function commitEpisode(sessionFile: string): Promise<number> {
  // TODO: #4 quality filter — strip fabricated callbacks before flipping provisional=false
  // For now: flip all provisional chunks matching this sessionFile to provisional=false
  const tbl = await initMemory();

  const rows = await tbl
    .query()
    .where(`provisional = true AND sessionFile = '${sessionFile.replace(/'/g, "''")}'`)
    .limit(1_000_000)
    .toArray();

  if (rows.length === 0) {
    console.log(`[memory] commitEpisode: 0 provisional chunks found for session "${sessionFile}"`);
    return 0;
  }

  // LanceDB doesn't support UPDATE — read, delete, re-insert with provisional=false.
  // Arrow proxy objects carry internal fields (vector.isValid) — deep-copy to plain JS.
  const updated = rows.map((r: any) => ({
    id: r.id,
    vector: Array.from(r.vector) as number[],
    text: r.text,
    episodeNumber: r.episodeNumber,
    episodeDate: r.episodeDate,
    episodeTitle: r.episodeTitle,
    guestName: r.guestName,
    topicTags: Array.from(r.topicTags).map((t: any) => String(t)),
    startTimestamp: r.startTimestamp,
    chunkIndex: r.chunkIndex,
    provisional: false,
    sessionFile: r.sessionFile,
  }));
  // Add new rows FIRST — if this fails, originals are still intact.
  await tbl.add(updated as unknown as Record<string, unknown>[]);
  const whereClause = `provisional = true AND sessionFile = '${sessionFile.replace(/'/g, "''")}'`;
  await tbl.delete(whereClause);

  console.log(`[memory] commitEpisode: flipped ${updated.length} chunks to committed for session "${sessionFile}"`);
  return updated.length;
}

/**
 * Format query results as a prompt-ready historical context block.
 */
export function formatMemoryBlock(results: MemoryQueryResult[]): string {
  if (!results || results.length === 0) return '';
  const lines = results.map((r) => {
    const snippet = r.text.length > 280 ? r.text.slice(0, 280).trimEnd() + '…' : r.text;
    return `- [Ep ${r.episodeNumber}, ${r.episodeDate}, Guest: ${r.guestName}] "${snippet}"`;
  });
  return `[HISTORICAL CONTEXT FROM PAST TWiST EPISODES]\n${lines.join('\n')}`;
}
