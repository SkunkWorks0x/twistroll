#!/bin/bash
# Usage: ./scripts/load-brief.sh [path/to/brief.json]
# Defaults to data/example-brief.json
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIEF_FILE="${1:-$SCRIPT_DIR/../data/example-brief.json}"

if [ ! -f "$BRIEF_FILE" ]; then
  echo "Brief file not found: $BRIEF_FILE" >&2
  exit 1
fi

curl -s -X POST http://localhost:3000/api/brief/load \
  -H "Content-Type: application/json" \
  -d @"$BRIEF_FILE"
echo
