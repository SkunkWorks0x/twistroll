#!/usr/bin/env tsx
// Timestamp-preserving JSONL replay for TWiSTroll.
//
// Reads a JSONL transcript, appends each line to a fresh OpenOats-shaped
// session folder, and spaces writes by the *actual* delta between adjacent
// `timestamp` fields divided by --rate. Cumulative drift is bounded by
// anchoring to wall-clock t0 instead of summing per-line delays.
//
// Usage:
//   tsx scripts/replay-session.ts --file <path.jsonl> [--rate 1.0] [--name demo]
//
// Flags:
//   --file  <path>    JSONL source (required)
//   --rate  <number>  playback speed multiplier, default 1.0
//   --name  <string>  session folder suffix, default "replay"
//   --limit <number>  only replay the first N lines (for testing)

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type Args = { file: string; rate: number; name: string; limit: number };

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 && i + 1 < a.length ? a[i + 1] : undefined;
  };
  const file = get("--file");
  if (!file) {
    console.error("ERROR: --file <path.jsonl> is required");
    process.exit(2);
  }
  const rate = parseFloat(get("--rate") ?? "1.0");
  if (!(rate > 0)) {
    console.error(`ERROR: --rate must be > 0, got ${rate}`);
    process.exit(2);
  }
  return {
    file,
    rate,
    name: get("--name") ?? "replay",
    limit: parseInt(get("--limit") ?? "0", 10) || 0,
  };
}

function parseTs(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs();
  const raw = fs.readFileSync(args.file, "utf8");
  const rawLines = raw.split("\n").filter((l) => l.trim().length > 0);
  const lines = args.limit > 0 ? rawLines.slice(0, args.limit) : rawLines;

  const parsed: { raw: string; ts: number | null }[] = lines.map((l) => {
    try {
      const obj = JSON.parse(l);
      return { raw: l, ts: parseTs(obj.timestamp) };
    } catch {
      return { raw: l, ts: null };
    }
  });

  const firstWithTs = parsed.find((p) => p.ts !== null);
  if (!firstWithTs) {
    console.error("ERROR: no parseable timestamp in source; cannot preserve cadence");
    process.exit(3);
  }
  const sourceT0 = firstWithTs.ts!;

  const transcriptDir =
    process.env.OPENOATS_TRANSCRIPT_DIR ??
    path.join(os.homedir(), "Library", "Application Support", "OpenOats", "sessions");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const sessionFolder = path.join(transcriptDir, `session_${args.name}_${stamp}`);
  const sessionFile = path.join(sessionFolder, "transcript.live.jsonl");
  fs.mkdirSync(sessionFolder, { recursive: true });
  fs.writeFileSync(sessionFile, "");

  const wall0 = Date.now();
  const sourceSpanMs = parsed[parsed.length - 1].ts
    ? parsed[parsed.length - 1].ts! - sourceT0
    : 0;
  console.log(`🔴 TWiSTroll Replay`);
  console.log(`   Source:   ${args.file} (${parsed.length} lines)`);
  console.log(`   Span:     ${(sourceSpanMs / 1000).toFixed(1)}s source → ${(sourceSpanMs / 1000 / args.rate).toFixed(1)}s wall (rate ${args.rate}x)`);
  console.log(`   Writing:  ${sessionFile}`);
  console.log("");

  let lastTs = sourceT0;
  let driftWarn = false;
  for (let i = 0; i < parsed.length; i++) {
    const { raw, ts } = parsed[i];
    const effectiveTs = ts ?? lastTs;
    const targetWall = wall0 + (effectiveTs - sourceT0) / args.rate;
    const waitMs = targetWall - Date.now();
    if (waitMs < -500 && !driftWarn) {
      console.warn(`   [drift] line ${i}: ${waitMs.toFixed(0)}ms behind schedule`);
      driftWarn = true;
    }
    await sleep(waitMs);

    fs.appendFileSync(sessionFile, raw + "\n");
    lastTs = effectiveTs;

    let speaker = "?", text = "";
    try {
      const obj = JSON.parse(raw);
      speaker = obj.speaker ?? "?";
      text = (obj.text ?? "").slice(0, 60);
    } catch {}
    const wallElapsed = ((Date.now() - wall0) / 1000).toFixed(1);
    console.log(`  [${wallElapsed.padStart(6)}s] [${speaker}] ${text}...`);
  }

  const totalWall = (Date.now() - wall0) / 1000;
  console.log("");
  console.log(`✅ Replay complete. Wall time: ${totalWall.toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
