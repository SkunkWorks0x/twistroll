#!/usr/bin/env bash
# Create a starter dossier template for a guest.
# Usage: ./scripts/build-dossier.sh "Alfred Lin"
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 \"Guest Name\"" >&2
  exit 1
fi

GUEST_NAME="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOSSIER_DIR="$SCRIPT_DIR/../data/dossiers"

# Slug: lowercase, strip punctuation, spaces -> hyphens
SLUG="$(echo "$GUEST_NAME" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9[:space:]-]//g' \
  | sed -E 's/[[:space:]]+/-/g')"

mkdir -p "$DOSSIER_DIR"
OUT="$DOSSIER_DIR/$SLUG.json"

if [ -e "$OUT" ]; then
  echo "Dossier already exists: $OUT" >&2
  exit 1
fi

cat > "$OUT" <<EOF
{
  "name": "$GUEST_NAME",
  "company": "",
  "role": "",
  "recentNews": [
    "",
    "",
    ""
  ],
  "notableClaims": [
    "",
    "",
    ""
  ],
  "contradictionsToWatch": [
    "",
    ""
  ]
}
EOF

echo "Created starter dossier: $OUT"
echo "Fill in the fields by hand, then POST /api/dossier/load with {\"guestName\":\"$GUEST_NAME\"}"
