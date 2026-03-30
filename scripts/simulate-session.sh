#!/bin/bash
# Simulates OpenOats by appending JSONL lines to the watch directory one at a time.
# Usage: ./scripts/simulate-session.sh
# This lets you test TWiSTroll without a real OpenOats recording.

TRANSCRIPT_DIR="${OPENOATS_TRANSCRIPT_DIR:-$HOME/Library/Application Support/OpenOats/sessions}"
SAMPLE_FILE="demo/sample-transcript.jsonl"
SESSION_FOLDER="$TRANSCRIPT_DIR/session_$(date +%Y-%m-%d_%H-%M-%S)"
SESSION_FILE="$SESSION_FOLDER/transcript.live.jsonl"

# Ensure session subfolder exists (matches real OpenOats structure)
mkdir -p "$SESSION_FOLDER"

echo "🔴 TWiSTroll Test Session"
echo "   Writing to: $SESSION_FILE"
echo "   Appending one utterance every 8 seconds..."
echo "   Press Ctrl+C to stop"
echo ""

# Clear any existing test file
> "$SESSION_FILE"

# Read sample file line by line and append with delay
while IFS= read -r line; do
    echo "$line" >> "$SESSION_FILE"
    # Extract speaker and first few words for display
    SPEAKER=$(echo "$line" | grep -o '"speaker":"[^"]*"' | cut -d'"' -f4)
    TEXT=$(echo "$line" | grep -o '"refinedText":"[^"]*"' | cut -d'"' -f4 | head -c 60)
    echo "  [$SPEAKER] ${TEXT}..."
    sleep 8
done < "$SAMPLE_FILE"

echo ""
echo "✅ Test session complete. Check your TWiSTroll overlay!"
