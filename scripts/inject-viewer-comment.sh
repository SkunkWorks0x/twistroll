#!/usr/bin/env bash
# Inject a viewer comment into the audience pulse stream.
# Usage: ./scripts/inject-viewer-comment.sh "username" "comment text" [platform]
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <username> <text> [platform=manual]" >&2
  exit 1
fi

USERNAME="$1"
TEXT="$2"
PLATFORM="${3:-manual}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PULSE_DIR="$SCRIPT_DIR/../data"
PULSE_FILE="$PULSE_DIR/audience-pulse.jsonl"

mkdir -p "$PULSE_DIR"
touch "$PULSE_FILE"

TS="$(node -e 'process.stdout.write(String(Date.now()))')"

# Escape with node's JSON.stringify for correctness
LINE="$(node -e '
const [ts, user, text, platform] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  timestamp: Number(ts),
  username: user,
  text,
  platform,
}));
' "$TS" "$USERNAME" "$TEXT" "$PLATFORM")"

echo "$LINE" >> "$PULSE_FILE"
echo "Injected viewer comment → $PULSE_FILE"
echo "  $LINE"
