#!/usr/bin/env bash
# Phase 1 smoke test for cross-episode memory.
# Ingests a sample TWiST episode transcript, runs two queries, prints latency + top scores.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

exec npx tsx scripts/test-episode-memory.ts
