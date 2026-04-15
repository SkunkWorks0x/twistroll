// diagnostics-preload.cjs
//
// Preloaded before the server entry point via `node --require`. Active only
// when DIAGNOSTICS=1 is set in the environment. Produces:
//
//   1. Console log every 30s with RSS, heap used, heap total, external (MB).
//      Prefixed with `[heap]` so it's easy to grep.
//   2. A heap snapshot (.heapsnapshot, Chromium format) every 5 minutes,
//      written to data/diagnostics/snapshot-T<minutes>.heapsnapshot.
//      Open in Chrome DevTools → Memory tab → Load profile → diff two
//      snapshots via "Comparison" dropdown.
//
// This file does NOT touch server code. It only hooks Node process + v8.
// Safe to ship (guarded by env var; absent var → silent no-op).

'use strict';

if (process.env.DIAGNOSTICS !== '1') {
  // No-op in normal dev/prod runs.
  return;
}

const v8 = require('v8');
const path = require('path');
const fs = require('fs');

const SNAPSHOT_DIR = path.resolve(__dirname, '..', 'data', 'diagnostics');
const LOG_EVERY_MS = 30_000;
const SNAPSHOT_EVERY_MS = 5 * 60_000;

try {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
} catch {
  // swallow — startup logger will surface real issues
}

const startMs = Date.now();
let snapshotCount = 0;

function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

function elapsedMin() {
  return ((Date.now() - startMs) / 60_000).toFixed(1);
}

// Memory log every 30s — survives the whole process lifetime
setInterval(() => {
  const mu = process.memoryUsage();
  console.log(
    `[heap] T+${elapsedMin()}m rss=${fmtMB(mu.rss)} heapUsed=${fmtMB(mu.heapUsed)} heapTotal=${fmtMB(mu.heapTotal)} external=${fmtMB(mu.external)} arrayBuffers=${fmtMB(mu.arrayBuffers || 0)}`
  );
}, LOG_EVERY_MS).unref();

// Heap snapshot every 5 min — first one after 5 min (not at T=0; that's
// pre-boot and uninteresting). Filename encodes minutes-since-start.
function takeSnapshot(labelMin) {
  try {
    const filename = `snapshot-T${String(labelMin).padStart(2, '0')}min.heapsnapshot`;
    const fullPath = path.join(SNAPSHOT_DIR, filename);
    const startSnap = Date.now();
    v8.writeHeapSnapshot(fullPath);
    const elapsed = Date.now() - startSnap;
    const size = fs.statSync(fullPath).size;
    console.log(
      `[heap] snapshot written: ${filename} (${fmtMB(size)}, took ${elapsed}ms)`
    );
  } catch (err) {
    console.warn(`[heap] snapshot failed: ${err && err.message ? err.message : err}`);
  }
}

// T+0 snapshot right after startup (well, after the 30s first log fires it's
// still basically idle if simulate hasn't started). Actually, take it at 30s
// so the server has warmed up.
setTimeout(() => takeSnapshot(0), 30_000);

// Then every 5 min
setInterval(() => {
  snapshotCount++;
  const labelMin = snapshotCount * 5;
  takeSnapshot(labelMin);
}, SNAPSHOT_EVERY_MS).unref();

console.log('[heap] diagnostics-preload active — RSS log every 30s, snapshots every 5 min to data/diagnostics/');
