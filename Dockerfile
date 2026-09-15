# afk server image: builds the dashboard and compiles the server, then runs the
# compiled server with node alone. tsx is a devDependency and only used by
# `pnpm dev:server`; it is not in this image.

# The tag is kept for readability; the digest is what is actually pulled. It is the
# multi-arch manifest list (OCI image index) for node:22-alpine, not one platform's
# image manifest, so the same line resolves on an amd64 runner and an arm64 laptop.
# Dependabot (.github/dependabot.yml) bumps it; to do it by hand, take `digest` from
# https://hub.docker.com/v2/repositories/library/node/tags/22-alpine or run
# `docker buildx imagetools inspect node:22-alpine`, and change both FROM lines.
FROM node:26-alpine@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868 AS base
WORKDIR /app
# Pin pnpm to the version the repo's packageManager field declares, so this stays
# in sync with the monorepo instead of drifting from a hardcoded version here.
COPY package.json ./package.json
RUN corepack enable && \
    PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")" && \
    corepack prepare "pnpm@${PNPM_VERSION}" --activate

# -----------------------------------------------------------------------------
# `build`: a full install (including devDependencies -- typescript, vite, eslint,
# ...) so `pnpm build` can compile @afk/shared and @afk/server (tsc, see their
# tsconfig.build.json) and build the dashboard (vite). Only the three dist
# directories make it into the final image; this whole stage is discarded.
# -----------------------------------------------------------------------------
FROM base AS build
# The commit this image is built from, passed by infra/deploy.sh. .git is not in the
# build context, so Vite cannot ask git itself; it reads AFK_BUILD_SHA instead and
# writes it into packages/web/dist/version.json. Empty when not passed, which the
# server and Vite both treat as unset.
ARG GIT_SHA=""
ENV AFK_BUILD_SHA=${GIT_SHA}
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# -----------------------------------------------------------------------------
# `prod-deps`: a second, from-scratch install, scoped with --filter to just
# @afk/server and the workspace packages it depends on (@afk/shared), and --prod
# to skip devDependencies. This is what keeps the runtime image from also
# carrying react/vite/eslint/etc: a plain `pnpm install --prod` at the workspace
# root would still pull in @afk/web's *dependencies* (react, tanstack, ...) even
# though nothing at runtime needs them.
# -----------------------------------------------------------------------------
FROM base AS prod-deps
# The lockfile is required for --frozen-lockfile; the manifests alone are not enough.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json ./packages/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/web/package.json ./packages/web/package.json
RUN pnpm install --frozen-lockfile --prod --filter "@afk/server..."

# -----------------------------------------------------------------------------
# Runtime: pruned node_modules from `prod-deps`, the compiled server and shared
# package and the built dashboard from `build`, the client script, and the two
# package manifests node needs to resolve them. No TypeScript source, no
# typescript/tsx/vite/react/eslint anywhere in this image.
# -----------------------------------------------------------------------------
FROM node:26-alpine@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The heap ceiling matches the admission math (AdmissionLimits in
# packages/server/src/env.ts, sized for the 512 MB Lightsail node): if the limits are
# ever wrong, V8 fails with a heap trace at 384 MB instead of the container being
# SIGKILLed by the OOM killer with nothing in the log.
ENV NODE_OPTIONS=--max-old-space-size=384
# Build identity, reported by GET /versionz and compared by infra/deploy.sh after a
# rollout. Both come from --build-arg (see deploy.sh); empty means unset.
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV AFK_BUILD_SHA=${GIT_SHA} AFK_BUILD_TIME=${BUILD_TIME}

# pnpm's layout: the real packages under /app/node_modules/.pnpm, and each workspace
# package's node_modules holding symlinks into it (plus the @afk/shared workspace
# link). node follows the symlinks; no pnpm is needed at runtime.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules

# packages/server/package.json is read at startup for the version /versionz reports;
# packages/shared/package.json is the `exports` map through which the compiled server's
# `import "@afk/shared"` reaches packages/shared/dist (its `afk-compiled` condition,
# selected by the --conditions flag in CMD below).
COPY packages/server/package.json ./packages/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist

# packages/server/src/paths.ts derives the repo root from its own location (three
# directories up from dist/paths.js) and expects the dashboard at packages/web/dist
# and the client at cli/afk under it -- so the image keeps the repo layout rather
# than flattening it. The client is served at /cli/afk and by the /install
# one-liner, so it has to ship in the image.
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY cli/afk ./cli/afk

# The default `disk` storage writes to packages/server/data (also from paths.ts).
# Production uses the bucket, but an image run without AFK_STORAGE=s3 still has to
# be able to write there as the unprivileged user.
RUN mkdir -p packages/server/data && chown node:node packages/server/data

# Run as the image's unprivileged user: nothing here needs root, and a bug in the
# server should not hand out root in the container.
USER node

# node is PID 1, with no pnpm or shell in front of it, so SIGTERM from a deploy
# reaches the server's own handler (packages/server/src/shutdown.ts) and it can
# drain its writes before exiting. --conditions=afk-compiled makes `@afk/shared`
# resolve to its compiled dist (see packages/shared/package.json); without it node
# would land on the TypeScript source and refuse the .ts extension.
EXPOSE 4141
CMD ["node", "--conditions=afk-compiled", "packages/server/dist/index.js"]
