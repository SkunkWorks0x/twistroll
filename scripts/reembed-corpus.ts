// Rebuild the LanceDB table with OpenAI text-embedding-3-small vectors.
// Required when switching EMBED_PROVIDER (vector dim is fixed in the schema).

import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, FixedSizeList, Float32 } from 'apache-arrow';
import { config } from 'dotenv';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
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
const VECTOR_DIM = 1536;
const CACHE_PATH = resolve(DB_PATH, '..', 'reembed-cache.ndjson');

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

// Build the new table schema from the existing table's schema, swapping only
// the vector field to the new dimension. Avoids guessing apache-arrow inner
// item names and nullability — we inherit them from the live schema.
function rebuildSchemaWithNewVectorDim(existing: Schema, dim: number): Schema {
  const newFields = existing.fields.map((f) => {
    if (f.name === 'vector') {
      return new Field(
        'vector',
        new FixedSizeList(dim, new Field('item', new Float32(), true)),
        f.nullable
      );
    }
    return f;
  });
  return new Schema(newFields);
}

function loadCacheIfMatches(expectedCount: number): Record<string, unknown>[] | null {
  if (!existsSync(CACHE_PATH)) return null;
  const lines = readFileSync(CACHE_PATH, 'utf8').split('\n').filter((l) => l.length > 0);
  if (lines.length !== expectedCount) {
    console.log(`Embedding cache exists but line count (${lines.length}) doesn't match source rows (${expectedCount}) — ignoring.`);
    return null;
  }
  console.log(`Found embedding cache (${lines.length} chunks). Skipping OpenAI API calls.`);
  return lines.map((l) => JSON.parse(l));
}

function writeCache(out: Record<string, unknown>[]): void {
  writeFileSync(CACHE_PATH, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`Wrote embedding cache: ${CACHE_PATH} (${out.length} chunks)`);
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
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

  const existingSchema = await tbl.schema();
  const newSchema = rebuildSchemaWithNewVectorDim(existingSchema, VECTOR_DIM);

  let out = loadCacheIfMatches(rows.length);
  if (!out) {
    if (!apiKey) throw new Error('OPENAI_API_KEY required');
    out = [];
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
    // Persist before the destructive write — if createTable fails (as it did
    // last run on schema inference), a re-run picks the cache up and skips
    // the OpenAI spend entirely.
    writeCache(out);
  }

  // Atomic replace with an explicit schema so empty arrays in row 0
  // (topicTags) don't trip Arrow type inference. Vector dim was the only
  // field that changed between providers.
  await conn.createTable(TABLE_NAME, out, { mode: 'overwrite', schema: newSchema });
  const dim = (out[0]?.vector as number[] | undefined)?.length ?? 0;
  console.log(`Re-embed complete. ${out.length} chunks written (${dim}-dim).`);

  unlinkSync(CACHE_PATH);
  console.log('Cache cleared.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
