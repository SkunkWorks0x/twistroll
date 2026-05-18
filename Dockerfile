# syntax=docker/dockerfile:1.7

# Builder — compile TypeScript to dist/.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime — slim glibc base (LanceDB native bindings don't run on musl/Alpine).
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ffmpeg + yt-dlp drive the Deepgram audio-pull pipeline (see deepgram.ts).
# ca-certificates is required for outbound HTTPS to Anthropic/OpenAI/Tavily.
# yt-dlp_linux is the PyInstaller standalone binary — the plain `yt-dlp` asset
# is a Python zipimport that needs a system Python (bookworm-slim has none).
# Pinned to a known-good release; yt-dlp ships ~weekly and regressions happen.
ARG YT_DLP_VERSION=2026.03.17
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux" \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY public ./public
COPY data/lance-db ./data/lance-db
COPY data/dossiers ./data/dossiers

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/server/index.js"]
