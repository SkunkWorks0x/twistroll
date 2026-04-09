/**
 * YouTube backfill for TWiSTroll cross-episode memory.
 *
 * Reads URLs from data/backfill/youtube-urls.txt, fetches metadata + auto-captions
 * via yt-dlp, cleans the VTT, and calls ingestEpisode() for each one.
 *
 * Usage:
 *   npx tsx scripts/backfill-youtube.ts [--force] [--limit N] [--dry-run]
 */
import { execFileSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ingestEpisode, initMemory } from '../src/server/episodeMemory.js';
import * as lancedb from '@lancedb/lancedb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const URL_FILE = resolve(ROOT, 'data', 'backfill', 'youtube-urls.txt');

// ─── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const deleteIdx = args.indexOf('--delete-episode');
const DELETE_EPISODE = deleteIdx >= 0 ? parseInt(args[deleteIdx + 1], 10) : NaN;

// ─── Types ─────────────────────────────────────────────────────────────
interface VideoMeta {
  url: string;
  videoId: string;
  title: string;
  uploadDate: string; // YYYYMMDD
  duration: string;
  description: string;
}

interface BackfillResult {
  url: string;
  episodeNumber: number;
  date: string;
  guestName: string;
  title: string;
  wordCount: number;
  chunkCount: number;
  status: 'success' | 'skipped' | 'failed' | 'dry-run';
  error?: string;
}

// ─── URL list parsing ──────────────────────────────────────────────────
function loadUrls(): string[] {
  if (!existsSync(URL_FILE)) {
    console.error(`[backfill] URL file not found: ${URL_FILE}`);
    process.exit(1);
  }
  return readFileSync(URL_FILE, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .filter((l) => {
      if (!/youtube\.com|youtu\.be/.test(l)) {
        console.warn(`[backfill] Skipping non-YouTube line: ${l}`);
        return false;
      }
      return true;
    });
}

// ─── yt-dlp helpers ────────────────────────────────────────────────────
function ytMeta(url: string): VideoMeta {
  // Use --dump-json so titles containing pipes or newlines don't break parsing.
  const out = execFileSync('yt-dlp', ['--dump-json', '--no-warnings', '--skip-download', url], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const j = JSON.parse(out) as {
    id: string;
    title: string;
    upload_date?: string;
    duration?: number | string;
    description?: string;
  };
  return {
    url,
    videoId: j.id,
    title: j.title ?? '',
    uploadDate: j.upload_date ?? '',
    duration: String(j.duration ?? ''),
    description: j.description ?? '',
  };
}

function ytDownloadCaptions(videoId: string, url: string): string | null {
  const outBase = `/tmp/twist-${videoId}`;
  const vttPath = `${outBase}.en.vtt`;

  try {
    execFileSync(
      'yt-dlp',
      [
        '--write-auto-subs',
        '--sub-lang',
        'en',
        '--skip-download',
        '--sub-format',
        'vtt',
        '--no-warnings',
        '-o',
        outBase,
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backfill] yt-dlp caption download failed for ${videoId}: ${msg}`);
    return null;
  }

  if (!existsSync(vttPath)) {
    console.error(`[backfill] VTT not found at ${vttPath} (auto-captions may be unavailable)`);
    return null;
  }
  return vttPath;
}

// ─── VTT cleaning ──────────────────────────────────────────────────────
function cleanVtt(vttPath: string): string {
  const raw = readFileSync(vttPath, 'utf-8');
  const lines = raw.split('\n');

  const cleaned: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('WEBVTT')) continue;
    if (/^\d\d:\d\d:\d\d[.,]\d{3}\s*-->/.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // cue identifier
    if (line.startsWith('Kind:') || line.startsWith('Language:')) continue;
    if (line.startsWith('NOTE')) continue;

    // Strip inline timestamp tags like <00:00:12.345> and <c> style tags
    const stripped = line
      .replace(/<\d\d:\d\d:\d\d[.,]\d{3}>/g, '')
      .replace(/<\/?c[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (!stripped) continue;

    // Deduplicate consecutive identical lines (YouTube auto-caption build-up)
    if (cleaned.length > 0 && cleaned[cleaned.length - 1] === stripped) continue;
    cleaned.push(stripped);
  }

  // Further dedupe: YouTube often emits rolling prefixes — if line N is a
  // prefix of line N+1, drop line N (the longer line supersedes it).
  const collapsed: string[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const cur = cleaned[i];
    const next = cleaned[i + 1];
    if (next && next.startsWith(cur) && next.length > cur.length) continue;
    collapsed.push(cur);
  }

  return collapsed.join(' ').replace(/\s+/g, ' ').trim();
}

// ─── Metadata extraction ───────────────────────────────────────────────
function extractEpisodeNumber(title: string, videoId: string): number {
  const patterns = [/E(\d{2,5})\b/i, /Episode (\d{2,5})/i, /#(\d{2,5})/, /\b(\d{4})\b/];
  for (const pat of patterns) {
    const m = title.match(pat);
    if (m) return parseInt(m[1], 10);
  }
  // Fallback: stable hash of videoId
  let h = 0;
  for (const c of videoId) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return h;
}

function extractGuestName(title: string): string {
  const patterns: RegExp[] = [
    /with ([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)+)\s*:/,
    /with ([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)+)\s*[—–-]/,
    /with ([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)+)(?:\s*,|\s*$)/,
    /([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)+)\s+on\s/,
    /feat\.?\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
    /ft\.?\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
  ];
  for (const pat of patterns) {
    const m = title.match(pat);
    if (m) return m[1].trim();
  }
  return '';
}

function parseUploadDate(ymd: string): string {
  if (!/^\d{8}$/.test(ymd)) return '';
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// ─── LanceDB existence check ───────────────────────────────────────────
async function episodeExists(tbl: lancedb.Table, episodeNumber: number): Promise<boolean> {
  try {
    const rows = await tbl
      .query()
      .where(`episodeNumber = ${episodeNumber}`)
      .limit(1)
      .toArray();
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  const startTotal = Date.now();

  // Delete-episode mode: short-circuit before touching URL list.
  if (!isNaN(DELETE_EPISODE)) {
    const tbl = await initMemory();
    const existing = await tbl
      .query()
      .where(`episodeNumber = ${DELETE_EPISODE}`)
      .limit(100000)
      .toArray()
      .catch(() => [] as unknown[]);
    if (existing.length === 0) {
      console.log(`[backfill] No chunks found for Ep ${DELETE_EPISODE} — nothing to delete`);
      return;
    }
    await tbl.delete(`episodeNumber = ${DELETE_EPISODE}`);
    console.log(`[backfill] Deleted ${existing.length} chunks for Ep ${DELETE_EPISODE}`);
    return;
  }

  const urls = loadUrls().slice(0, LIMIT);

  console.log('[backfill] ════════════════════════════════');
  console.log(`[backfill] URLs to process: ${urls.length}`);
  console.log(`[backfill] Flags: force=${FORCE} dry-run=${DRY_RUN} limit=${isFinite(LIMIT) ? LIMIT : 'none'}`);
  console.log('[backfill] ════════════════════════════════');

  if (urls.length === 0) {
    console.log('[backfill] No URLs to process. Add real YouTube URLs to', URL_FILE);
    return;
  }

  const tbl = await initMemory();
  const results: BackfillResult[] = [];

  for (const url of urls) {
    console.log(`\n[backfill] → ${url}`);
    const r: BackfillResult = {
      url,
      episodeNumber: 0,
      date: '',
      guestName: '',
      title: '',
      wordCount: 0,
      chunkCount: 0,
      status: 'failed',
    };

    try {
      const meta = ytMeta(url);
      r.title = meta.title;
      r.episodeNumber = extractEpisodeNumber(meta.title, meta.videoId);
      r.guestName = extractGuestName(meta.title);
      r.date = parseUploadDate(meta.uploadDate);
      console.log(`[backfill]   title:   ${meta.title}`);
      console.log(`[backfill]   ep #:    ${r.episodeNumber}`);
      console.log(`[backfill]   date:    ${r.date}`);
      console.log(`[backfill]   guest:   ${r.guestName || '(not extracted)'}`);
      console.log(`[backfill]   duration:${meta.duration}s`);

      const already = await episodeExists(tbl, r.episodeNumber);
      if (already && !FORCE && !DRY_RUN) {
        console.log(`[backfill] Ep ${r.episodeNumber} already ingested, skipping (use --force to re-ingest)`);
        r.status = 'skipped';
        results.push(r);
        continue;
      }

      const vttPath = ytDownloadCaptions(meta.videoId, url);
      if (!vttPath) {
        r.error = 'caption download failed';
        results.push(r);
        continue;
      }

      const transcriptText = cleanVtt(vttPath);
      r.wordCount = transcriptText.split(/\s+/).filter(Boolean).length;
      console.log(`[backfill]   words:   ${r.wordCount}`);

      if (DRY_RUN) {
        console.log(`[backfill]   [DRY-RUN] would ingest ${r.wordCount} words`);
        r.status = 'dry-run';
        try { unlinkSync(vttPath); } catch { /* ignore */ }
        results.push(r);
        continue;
      }

      const ingestStart = Date.now();
      const chunkCount = await ingestEpisode({
        episodeNumber: r.episodeNumber,
        episodeDate: r.date,
        episodeTitle: r.title,
        guestName: r.guestName,
        topicTags: [],
        transcriptText,
        startTimestamp: 0,
      });
      const ingestMs = Date.now() - ingestStart;
      r.chunkCount = chunkCount;
      r.status = 'success';
      console.log(
        `[backfill] Ep ${r.episodeNumber} (${r.date}) — ${r.guestName || 'unknown guest'} — ${chunkCount} chunks in ${ingestMs}ms`
      );

      try { unlinkSync(vttPath); } catch { /* ignore */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[backfill] FAILED: ${msg}`);
      r.error = msg;
      r.status = 'failed';
    }

    results.push(r);
  }

  const totalS = ((Date.now() - startTotal) / 1000).toFixed(1);
  const successful = results.filter((r) => r.status === 'success').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const dry = results.filter((r) => r.status === 'dry-run').length;
  const totalChunks = results.reduce((sum, r) => sum + r.chunkCount, 0);

  console.log('\n[backfill] ════════════════════════════════');
  console.log(`[backfill] Total episodes processed: ${results.length}`);
  console.log(`[backfill] Successful: ${successful}`);
  console.log(`[backfill] Dry-run:    ${dry}`);
  console.log(`[backfill] Skipped (already ingested): ${skipped}`);
  console.log(`[backfill] Failed: ${failed}`);
  console.log(`[backfill] Total chunks added: ${totalChunks}`);
  console.log(`[backfill] Total time: ${totalS}s`);
  console.log('[backfill] ════════════════════════════════');
}

main().catch((err) => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
