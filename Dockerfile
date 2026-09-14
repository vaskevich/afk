# afk server image: builds the dashboard, then runs the server through tsx.
#
# TODO(deploy): compile packages/server to plain JS instead of running it through
# tsx in production, once the server has a build step (see BACKLOG.md
# "Deployment"). Until then, tsx has to ship in the runtime image, which is why
# it's a "dependency" of @afk/server rather than a "devDependency" -- see below.

# The tag is kept for readability; the digest is what is actually pulled. It is the
# multi-arch manifest list (OCI image index) for node:22-alpine, not one platform's
# image manifest, so the same line resolves on an amd64 runner and an arm64 laptop.
# Dependabot (.github/dependabot.yml) bumps it; to do it by hand, take `digest` from
# https://hub.docker.com/v2/repositories/library/node/tags/22-alpine or run
# `docker buildx imagetools inspect node:22-alpine`, and change both FROM lines.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
WORKDIR /app
# Pin pnpm to the version the repo's packageManager field declares, so this stays
# in sync with the monorepo instead of drifting from a hardcoded version here.
COPY package.json ./package.json
RUN corepack enable && \
    PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")" && \
    corepack prepare "pnpm@${PNPM_VERSION}" --activate

# -----------------------------------------------------------------------------
# `build`: a full install (including devDependencies -- vite, typescript, eslint,
# ...) so `pnpm build` can build the dashboard. Only its output (packages/web/dist)
# makes it into the final image; this whole stage is discarded afterwards.
# -----------------------------------------------------------------------------
FROM base AS build
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
#
# `tsx` ships here rather than being pruned with the rest of the devDependencies
# because the server still runs through it in production -- see the TODO above.
# It was moved from "devDependencies" to "dependencies" in packages/server's own
# package.json for exactly this reason.
# -----------------------------------------------------------------------------
FROM base AS prod-deps
# The lockfile is required for --frozen-lockfile; the manifests alone are not enough.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json ./packages/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/web/package.json ./packages/web/package.json
RUN pnpm install --frozen-lockfile --prod --filter "@afk/server..."

# -----------------------------------------------------------------------------
# Runtime: pruned node_modules from `prod-deps`, the source the server actually
# needs to run (its own src plus @afk/shared's, since neither is compiled), and
# the built dashboard from `build`. No vite/react/eslint/typescript anywhere in
# this image.
# -----------------------------------------------------------------------------
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=base /app/package.json ./package.json
COPY pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules

COPY packages/server/package.json packages/server/tsconfig.json ./packages/server/
COPY packages/server/src ./packages/server/src
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src

# packages/server/src/config.ts resolves the dashboard at "../../web/dist" and the
# client script at "../../../cli/afk" relative to its own directory, i.e.
# packages/web/dist and cli/afk from the repo root -- keep that same relative
# layout here rather than flattening it. The client is served at /cli/afk and by
# the /install one-liner, so it has to ship in the image.
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY cli/afk ./cli/afk

# corepack's activation from the `base` stage doesn't carry over a fresh
# `FROM node:22-alpine`; re-pin pnpm the same way.
RUN corepack enable && \
    PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")" && \
    corepack prepare "pnpm@${PNPM_VERSION}" --activate

EXPOSE 4141
CMD ["pnpm", "--filter", "@afk/server", "start"]
