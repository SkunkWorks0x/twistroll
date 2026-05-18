// Rebuild the LanceDB table with OpenAI text-embedding-3-small vectors.
// Required when switching EMBED_PROVIDER (vector dim is fixed in the schema).

import * as lancedb from '@lancedb/lancedb';
import { config } from 'dotenv';
import {
  DB_PATH,
  TABLE_NAME,
  OPENAI_EMBED_MODEL,
  OPENAI_EMBED_URL,
} from '../src/server/episodeMemory.js';

config();

// ~800 tokens per ~600-word chunk × 50 = ~40k tokens/batch. With a 3s gap
// that's ~800k tokens/min steady-state — under the tier-1 1M TPM ceiling on
// text-embedding-3-small. Retries cover transient spikes.
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 3000;
const MAX_RATE_LIMIT_RETRIES = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  for (let retry = 0; retry <= MAX_RATE_LIMIT_RETRIES; retry++) {
    const res = await fetch(OPENAI_EMBED_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input: texts }),
    });
    if (res.status === 429 && retry < MAX_RATE_LIMIT_RETRIES) {
      console.log('Rate limited — waiting 60s before retry...');
      await sleep(60_000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    // OpenAI docs document an `index` field but don't explicitly guarantee
    // positional order — sort to be safe. Free at this batch size.
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  throw new Error('unreachable');
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY required');
  }

  const conn = await lancedb.connect(DB_PATH);
  const names = await conn.tableNames();
  if (!names.includes(TABLE_NAME)) {
    throw new Error(`Table "${TABLE_NAME}" not found at ${DB_PATH}`);
  }

  const tbl = await conn.openTable(TABLE_NAME);
  const rows = await tbl.query().limit(1_000_000).toArray();
  console.log(`Read ${rows.length} chunks from existing "${TABLE_NAME}" table`);
  if (rows.length === 0) {
    throw new Error('Existing table is empty — nothing to re-embed');
  }

  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const vectors = await embedBatch(
      batch.map((r: any) => r.text),
      apiKey
    );
    for (let j = 0; j < batch.length; j++) {
      const r: any = batch[j];
      out.push({
        id: r.id,
        vector: vectors[j],
        text: r.text,
        episodeNumber: r.episodeNumber,
        episodeDate: r.episodeDate,
        episodeTitle: r.episodeTitle,
        guestName: r.guestName,
        topicTags: Array.from(r.topicTags).map((t: any) => String(t)),
        startTimestamp: r.startTimestamp,
        chunkIndex: r.chunkIndex,
        provisional: r.provisional,
        sessionFile: r.sessionFile ?? '',
        sourceKind: r.sourceKind ?? 'transcript',
        evidenceRole: r.evidenceRole ?? 'primary',
        generatedBy: r.generatedBy ?? '',
      });
    }
    console.log(`Re-embedded ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} chunks…`);
    if (i + BATCH_SIZE < rows.length) await sleep(BATCH_DELAY_MS);
  }

  // Atomic replace — `mode: 'overwrite'` swaps the table in one operation so
  // a mid-script crash can't leave the corpus in a deleted state. Vector dim
  // is fixed in the schema, so a fresh overwrite is required when switching
  // providers (768-dim embeddinggemma → 1536-dim text-embedding-3-small).
  await conn.createTable(TABLE_NAME, out, { mode: 'overwrite' });
  const dim = (out[0]?.vector as number[] | undefined)?.length ?? 0;
  console.log(`Re-embed complete. ${out.length} chunks written (${dim}-dim).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
