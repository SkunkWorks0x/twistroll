#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

FAIL=0

echo "🔴 TWiST Sentinel — Pre-flight Check"
echo "======================================"
echo ""

# 1. Node.js (need >= 18 for tsx)
if command -v node &>/dev/null; then
  NODE_V=$(node -v | sed 's/v//')
  echo -e "${GREEN}✓${NC} Node.js $NODE_V"
else
  echo -e "${RED}✗${NC} Node.js not found — install from https://nodejs.org (>=18)"
  FAIL=1
fi

# 2. CLI binaries
for bin in yt-dlp ffmpeg; do
  if command -v "$bin" &>/dev/null; then
    echo -e "${GREEN}✓${NC} $bin"
  else
    echo -e "${RED}✗${NC} $bin not found — brew install $bin (or see README)"
    FAIL=1
  fi
done

# 3. Ollama daemon — only needed when local embeddings are in use.
#    EMBED_PROVIDER=openai uses cloud embeddings and doesn't touch Ollama.
if [ "${EMBED_PROVIDER:-}" != "openai" ]; then
  if curl -sf http://${OLLAMA_BASE_URL:-localhost:11434}/api/tags &>/dev/null; then
    echo -e "${GREEN}✓${NC} Ollama daemon running"

    # 3a. Required models
    MODELS=$(curl -sf http://${OLLAMA_BASE_URL:-localhost:11434}/api/tags)
    for model in embeddinggemma qwen2.5; do
      if echo "$MODELS" | grep -qi "$model"; then
        echo -e "${GREEN}✓${NC}   Model: $model"
      else
        echo -e "${RED}✗${NC}   Model $model not pulled — run: ollama pull $model"
        FAIL=1
      fi
    done
  else
    echo -e "${RED}✗${NC} Ollama not running — start with: ollama serve"
    FAIL=1
  fi
fi

# 4. .env file exists
if [ -f .env ]; then
  echo -e "${GREEN}✓${NC} .env file found"
else
  echo -e "${RED}✗${NC} .env file missing — copy .env.example to .env and fill in API keys"
  FAIL=1
fi

# 5 + 6. API key checks — skipped entirely if .env is missing (avoids tripping
# set -e on grep-against-missing-file; the .env-missing red mark above already
# tells the user what to fix).
if [ -f .env ]; then
  # Required API keys (functional-required — pipeline won't produce cards without these)
  for key in ANTHROPIC_API_KEY DEEPGRAM_API_KEY; do
    val=$(grep -E "^${key}=" .env 2>/dev/null | cut -d'=' -f2-)
    if [ -n "$val" ] && [ "$val" != "your-key-here" ] && [ "$val" != "" ]; then
      echo -e "${GREEN}✓${NC} $key set"
    else
      echo -e "${RED}✗${NC} $key missing or placeholder in .env"
      FAIL=1
    fi
  done

  # Optional keys (nice-to-have, yellow warning)
  for key in TAVILY_API_KEY GROQ_API_KEY; do
    val=$(grep -E "^${key}=" .env 2>/dev/null | cut -d'=' -f2-)
    if [ -n "$val" ] && [ "$val" != "your-key-here" ]; then
      echo -e "${GREEN}✓${NC} $key set"
    else
      echo -e "${YELLOW}⚠${NC} $key not set — web search / Groq fallback disabled (non-fatal)"
    fi
  done
fi

# 7. node_modules
if [ -d node_modules ]; then
  echo -e "${GREEN}✓${NC} node_modules present"
else
  echo -e "${YELLOW}⚠${NC} node_modules missing — running npm install..."
  npm install
fi

echo ""

if [ $FAIL -ne 0 ]; then
  echo -e "${RED}Pre-flight failed.${NC} Fix the issues above and re-run ./start.sh"
  exit 1
fi

echo -e "${GREEN}All checks passed.${NC} Starting TWiST Sentinel..."
echo ""
exec npm run dev
