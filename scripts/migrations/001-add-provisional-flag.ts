/**
 * Migration 001: Add provisional flag + sessionFile to the episodes table.
 *
 * - provisional (boolean, default true) — live chunks are provisional until committed
 * - sessionFile (string|null, default null) — scopes commits to the originating session
 *
 * Idempotent: if columns already exist, exits cleanly.
 * Usage: npx tsx scripts/migrations/001-add-provisional-flag.ts
 */
import * as lancedb from '@lancedb/lancedb';
import { DB_PATH, TABLE_NAME, initMemory } from '../../src/server/episodeMemory.js';

async function main() {
  console.log(`[migration-001] DB_PATH: ${DB_PATH}`);
  console.log(`[migration-001] TABLE_NAME: ${TABLE_NAME}`);

  const tbl = await initMemory();
  const schema = await tbl.schema();
  const fieldNames = schema.fields.map((f: { name: string }) => f.name);

  console.log(`[migration-001] Existing columns: ${fieldNames.join(', ')}`);

  const hasProvisional = fieldNames.includes('provisional');
  const hasSessionFile = fieldNames.includes('sessionFile');

  if (hasProvisional && hasSessionFile) {
    console.log('[migration-001] Both columns already exist — nothing to do.');
    return;
  }

  // LanceDB doesn't support ALTER TABLE ADD COLUMN directly. We need to read
  // all rows, add the new fields, drop the table, and recreate with the new schema.
  console.log('[migration-001] Reading all existing rows...');
  const rows = await tbl.query().limit(1_000_000).toArray();
  console.log(`[migration-001] Found ${rows.length} rows`);

  // Add missing columns with defaults. Deep-copy Arrow proxy objects to plain JS.
  const updated = rows.map((row: any) => ({
    id: row.id,
    vector: Array.from(row.vector) as number[],
    text: row.text,
    episodeNumber: row.episodeNumber,
    episodeDate: row.episodeDate,
    episodeTitle: row.episodeTitle,
    guestName: row.guestName,
    topicTags: Array.from(row.topicTags).map((t: any) => String(t)),
    startTimestamp: row.startTimestamp,
    chunkIndex: row.chunkIndex,
    provisional: hasProvisional ? row.provisional : false,
    sessionFile: hasSessionFile ? row.sessionFile : '',
  }));

  // Drop and recreate
  const conn = await lancedb.connect(DB_PATH);
  await conn.dropTable(TABLE_NAME);
  console.log(`[migration-001] Dropped table "${TABLE_NAME}"`);

  if (updated.length > 0) {
    await conn.createTable(TABLE_NAME, updated, { mode: 'create' });
    console.log(`[migration-001] Recreated table with ${updated.length} rows + new columns`);
  } else {
    console.log('[migration-001] Table was empty — it will be recreated on next initMemory() call');
  }

  // Verify
  const newTbl = await conn.openTable(TABLE_NAME);
  const newSchema = await newTbl.schema();
  const newFields = newSchema.fields.map((f: { name: string }) => f.name);
  console.log(`[migration-001] Final columns: ${newFields.join(', ')}`);
  console.log('[migration-001] Done.');
}

main().catch((err) => {
  console.error('[migration-001] Fatal:', err);
  process.exit(1);
});
