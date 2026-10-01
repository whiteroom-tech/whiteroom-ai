# Build context is the repo root (not apps/dashboard) so this can COPY the
# sibling packages/ui dependency pulled in via a `file:` link — Buildpacks
# can't do this since they only see a single --path directory.
# TODO: Pin to a reviewed digest (node:20-alpine@sha256:...) with automated updates
FROM node:20-alpine AS deps
WORKDIR /repo
COPY packages/ui ./packages/ui
COPY apps/dashboard/package.json apps/dashboard/package-lock.json ./apps/dashboard/
WORKDIR /repo/apps/dashboard
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /repo
COPY packages/ui ./packages/ui
COPY --from=deps /repo/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY apps/dashboard ./apps/dashboard
WORKDIR /repo/apps/dashboard
# NEXT_PUBLIC_* is inlined into the bundle at build time, so the engine URL is
# fixed per image. Staging passes its own; left empty, client.ts falls back to
# https://proxy.whiteroom.tech.
ARG NEXT_PUBLIC_PROXY_URL=
ENV NEXT_PUBLIC_PROXY_URL=$NEXT_PUBLIC_PROXY_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080
COPY --from=builder --chown=node:node /repo/apps/dashboard/public ./apps/dashboard/public
COPY --from=builder --chown=node:node /repo/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER node
EXPOSE 8080
CMD ["node", "apps/dashboard/server.js"]
