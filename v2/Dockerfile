# AgentSplit v2 for Coolify: compose.v2.coolify.yaml at the repository root
# builds this folder. The build stage installs the locked dependencies and
# runs `bun run build`. The final image holds only Bun and dist/: the server
# is one bundle, so it needs no node_modules.
# Both images are multi-arch indexes, pinned by digest. Bun matches the dev shell.
ARG BUN_IMAGE=oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e
ARG BUN_RUNTIME_IMAGE=oven/bun:1.3.13-distroless@sha256:fc372e3e810dff25356602172cc97423c6991a15bca22d191abc500d3f1a9eb8

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
# The lockfile is exact and package.json trusts no lifecycle scripts.
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build

FROM ${BUN_RUNTIME_IMAGE}
WORKDIR /app
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000 \
    CLIENT_DIR=/app/dist/client \
    MIGRATIONS_DIR=/app/dist/migrations
# The distroless user "nonroot". The files above stay owned by root, so the server cannot change them.
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# The image's entrypoint is bun.
CMD ["dist/server/server.js"]
