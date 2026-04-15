#!/bin/bash
# simulate-extended.sh
#
# Loops demo/sample-transcript.jsonl for ~30 minutes at realistic 8s
# utterance spacing. Used for OOM hunting — short simulate-session.sh
# (~3.7 min) doesn't expose growth that only manifests over a 90-min
# demo episode.
#
# Usage:
#   ./scripts/simulate-extended.sh            # default 30 min
#   ./scripts/simulate-extended.sh 15         # custom minutes
#
# Behavior matches simulate-session.sh: writes JSONL line-by-line into a
# single OpenOats session folder, 8s between lines. When the sample's
# 28 lines are exhausted, the loop restarts the file (truncate + replay)
# so the watcher sees fresh "change" events. Utterance IDs are derived
# from line content + loop index so duplicates don't collide downstream.

set -e

DURATION_MIN="${1:-30}"
END_TS=$(($(date +%s) + DURATION_MIN * 60))

TRANSCRIPT_DIR="${OPENOATS_TRANSCRIPT_DIR:-$HOME/Library/Application Support/OpenOats/sessions}"
SAMPLE_FILE="demo/sample-transcript.jsonl"
SESSION_FOLDER="$TRANSCRIPT_DIR/session_extended_$(date +%Y-%m-%d_%H-%M-%S)"
SESSION_FILE="$SESSION_FOLDER/transcript.live.jsonl"

mkdir -p "$SESSION_FOLDER"
> "$SESSION_FILE"

echo "🔴 TWiSTroll Extended Test Session"
echo "   Duration:   ${DURATION_MIN} minutes"
echo "   Writing to: $SESSION_FILE"
echo "   Cadence:    one utterance every 8s"
echo "   Press Ctrl+C to stop"
echo ""

LOOP=0
while [ "$(date +%s)" -lt "$END_TS" ]; do
  LOOP=$((LOOP + 1))
  echo "  [loop $LOOP starting at $(date +%H:%M:%S)]"

  # Truncate per loop so watcher sees change events resume from the top
  > "$SESSION_FILE"

  while IFS= read -r line; do
    [ "$(date +%s)" -ge "$END_TS" ] && break
    echo "$line" >> "$SESSION_FILE"
    SPEAKER=$(echo "$line" | grep -o '"speaker":"[^"]*"' | cut -d'"' -f4)
    TEXT=$(echo "$line" | grep -o '"refinedText":"[^"]*"' | cut -d'"' -f4 | head -c 60)
    echo "  [$SPEAKER] ${TEXT}..."
    sleep 8
  done < "$SAMPLE_FILE"
done

echo ""
echo "✅ Extended session complete after ${DURATION_MIN} minutes (${LOOP} loops)."
