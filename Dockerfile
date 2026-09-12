# Bridge image: llm-cli-proxy (fixed) + the Claude Code CLI, as used by the openwebui stack.
# Publishes to ghcr.io/<owner>/llm-cli-proxy, consumed by the homeserver openwebui stack.
#
# Pinned base + deps. @anthropic-ai/claude-code is needed by llm-cli-proxy's claude provider,
# which spawns `claude -p` per request. The codex provider calls the Codex backend directly
# from ~/.codex/auth.json and needs no extra binary.
FROM node:22.20.0-bookworm-slim

# Install the fixed llm-cli-proxy from this repo's source, plus the Claude Code CLI.
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build \
 && npm install -g . \
 && npm install -g @anthropic-ai/claude-code@2.1.269

# Run as uid 1000 so the mounted ~/.claude / ~/.codex auth dirs work.
USER node
WORKDIR /workspace
