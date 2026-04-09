#!/usr/bin/env bash
# Mark the current moment as clip-worthy. The clipper worker picks this up
# on the next scan and boosts any candidate in the surrounding window.
# Usage: ./scripts/clip-now.sh "reason"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
CLIPPER_DIR="$ROOT/data/clipper"
FILE="$CLIPPER_DIR/hotkeys.jsonl"

mkdir -p "$CLIPPER_DIR"

TIMESTAMP="$(node -e 'process.stdout.write(String(Date.now()))')"
REASON="${1:-manual}"

LINE="$(node -e '
const [ts, reason] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ timestamp: Number(ts), reason }));
' "$TIMESTAMP" "$REASON")"

echo "$LINE" >> "$FILE"
echo "Hotkey marker written at $TIMESTAMP → $FILE"
echo "  $LINE"
