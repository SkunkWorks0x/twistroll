/**
 * Post-backfill: flip all backfilled chunks from provisional=true to provisional=false.
 *
 * Backfilled chunks have sessionFile = '' (empty string sentinel for null).
 * Live chunks have sessionFile = <session folder name>.
 * This update targets backfill-only rows.
 *
 * Usage: npx tsx scripts/migrations/002-flip-backfill-provisional.ts
 */
import * as lancedb from '@lancedb/lancedb';
import { DB_PATH, TABLE_NAME, initMemory } from '../../src/server/episodeMemory.js';

async function main() {
  console.log(`[post-backfill] DB_PATH: ${DB_PATH}`);
  const tbl = await initMemory();

  // Find all provisional chunks with empty sessionFile (backfill rows)
  const rows = await tbl
    .query()
    .where("provisional = true AND sessionFile = ''")
    .limit(1_000_000)
    .toArray();

  console.log(`[post-backfill] Found ${rows.length} provisional backfill chunks to flip`);

  if (rows.length === 0) {
    console.log('[post-backfill] Nothing to do.');
    return;
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
  console.log(`[post-backfill] Added ${updated.length} committed copies`);

  // Now delete the old provisional rows.
  await tbl.delete("provisional = true AND sessionFile = ''");
  console.log(`[post-backfill] Deleted old provisional rows`);

  // Verify
  const remaining = await tbl
    .query()
    .where("provisional = true AND sessionFile = ''")
    .limit(1)
    .toArray();

  const committed = await tbl
    .query()
    .where("provisional = false")
    .limit(1_000_000)
    .toArray();

  console.log(`[post-backfill] Verification:`);
  console.log(`  provisional=true  (backfill): ${remaining.length}`);
  console.log(`  provisional=false (committed): ${committed.length}`);
  console.log('[post-backfill] Done.');
}

main().catch((err) => {
  console.error('[post-backfill] Fatal:', err);
  process.exit(1);
});
