# syntax=docker/dockerfile:1.7
# Lucent production image (M0.6).
#
# Stages:
#   deps  — install every workspace with dev deps so the compilers can run.
#   build — compile the TypeScript packages to JavaScript and build the web app.
#   run   — fresh image with prod deps only; `node` runs the compiled server.
#
# The run stage ships JavaScript, not TypeScript: a production image must not
# depend on a dev transpiler. `tsx` is a devDependency, so it is absent after
# `npm ci --omit=dev`, and @lucent/core / @lucent/ai resolve their default
# export condition to `dist/` (their `development`/`module` conditions keep
# pointing at `src/` for vitest, Vite and `tsx watch`).

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /repo
# libc6-compat for pg/sharp-style native modules; apk add is the Alpine idiom.
RUN apk add --no-cache libc6-compat
# packages/web depends on @huggingface/transformers, whose transitive
# onnxruntime-node dependency has a postinstall that downloads a ~300 MB CUDA
# execution-provider tarball from github.com releases (it assumes CUDA 12 when
# nvcc is absent). transformers.js only ever runs in the browser here, bundled
# by Vite, so the native GPU runtime is never loaded: skip the download instead
# of making the image build depend on GitHub release availability.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
# Copy lockfiles and manifests first so the install layer is cached across
# builds that don't touch deps.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/ai/package.json packages/ai/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/mcp/package.json packages/mcp/
COPY packages/i18n/package.json packages/i18n/
COPY packages/site/package.json packages/site/
COPY packages/load/package.json packages/load/
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /repo
COPY . .
# Compile exactly what ships: core/ai/server to `dist/` via tsc, and the web
# bundle via Vite (which reads core/ai from source through the `module`
# condition, so the four builds have no ordering constraint between them).
# `packages/mcp` is a developer tool and is not part of the image.
RUN npm run build -w @lucent/core -w @lucent/ai -w @lucent/i18n -w @lucent/server -w @lucent/web

FROM node:${NODE_VERSION}-alpine AS run
# Run as a non-root user. node:alpine ships with `node`; add a dedicated uid
# so the image doesn't run as uid 0.
RUN apk add --no-cache libc6-compat tini \
 && addgroup -S lucent && adduser -S lucent -G lucent
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/ai/package.json packages/ai/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/mcp/package.json packages/mcp/
COPY packages/i18n/package.json packages/i18n/
COPY packages/site/package.json packages/site/
COPY packages/load/package.json packages/load/
# Prod-only deps for the one workspace this image runs. `--omit=dev` drops
# tsx/drizzle-kit/vitest/typescript; `-w @lucent/server` drops every other
# workspace's runtime tree, which is what keeps the browser-side stack
# (@huggingface/transformers -> onnxruntime-node + sharp, livekit-client,
# react) out of a server image that cannot use it — those ship inside
# packages/web/dist, already bundled. 29 packages instead of several hundred,
# and no native postinstall runs at all. npm still links the @lucent/*
# workspaces the compiled output resolves its bare `@lucent/core` /
# `@lucent/ai` imports through.
RUN npm ci --omit=dev -w @lucent/server --no-audit --no-fund

# Copy compiled output only. `src/` is deliberately absent: nothing in the run
# stage can execute TypeScript. Tests, fixtures and dev configs never reach
# this stage anyway (.dockerignore).
COPY --from=build /repo/packages/core/dist packages/core/dist
COPY --from=build /repo/packages/ai/dist packages/ai/dist
COPY --from=build /repo/packages/server/dist packages/server/dist
# The migration runner reads the generated SQL from disk at boot, resolved
# relative to dist/db/ as ../../migrations.
COPY --from=build /repo/packages/server/migrations packages/server/migrations
# staticHandler serves this directory, resolved relative to dist/ as ../../web/dist.
COPY --from=build /repo/packages/web/dist packages/web/dist

USER lucent
EXPOSE 4387
# tini reaps zombies and forwards signals so SIGTERM actually reaches Node and
# main.ts's shutdown handler can close the WSS and the pg pool.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/dist/main.js"]

# Healthcheck: the server exposes /health (always 200 ok when the process is up).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4387/health || exit 1
