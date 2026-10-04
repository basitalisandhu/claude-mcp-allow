# syntax=docker/dockerfile:1
#
# The claude-mcp-allow CLI as an image. Build and run with:
#   docker build -t claude-mcp-allow .
#   docker run --rm -v "$PWD:/work" claude-mcp-allow --diff
#
# The base image is pinned by digest (node:22-alpine, multi-arch index).
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# Build on the runner's own platform: the output is plain JavaScript and the dependencies have no native code.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build
# Production tree: runtime dependencies from the committed lockfile, plus dist/.
WORKDIR /out
RUN cp /src/package.json /src/package-lock.json ./ \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && cp -R /src/dist ./dist \
 && rm -rf /root/.npm

FROM ${NODE_IMAGE}
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="claude-mcp-allow" \
      org.opencontainers.image.description="Least-privilege Claude Code permission rules for MCP tools, from their live annotations" \
      org.opencontainers.image.source="https://github.com/basitalisandhu/claude-mcp-allow" \
      org.opencontainers.image.url="https://github.com/basitalisandhu/claude-mcp-allow" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production
COPY --from=build /out/ /app/
# Mount the project at /work; .mcp.json and .claude/ are read from there.
WORKDIR /work
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
