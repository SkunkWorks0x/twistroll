#!/bin/bash
# Simulates OpenOats by replaying a JSONL file into the watch directory with
# timestamp-preserving cadence (honors the deltas between adjacent `timestamp`
# fields). Previous version used a flat `sleep 8` between lines, which broke
# natural pacing and mis-tested cooldowns.
#
# Usage:
#   ./scripts/simulate-session.sh                       # demo sample, 1x
#   ./scripts/simulate-session.sh --rate 2              # 2x speed
#   ./scripts/simulate-session.sh --file path.jsonl     # custom source
#   ./scripts/simulate-session.sh --limit 30 --rate 20  # quick test

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default source if --file not provided
DEFAULT_FILE="$REPO_ROOT/demo/sample-transcript.jsonl"
if [[ ! " $* " =~ " --file " ]]; then
  set -- --file "$DEFAULT_FILE" "$@"
fi

# Default name
if [[ ! " $* " =~ " --name " ]]; then
  set -- --name "sim" "$@"
fi

exec npx tsx "$SCRIPT_DIR/replay-session.ts" "$@"
