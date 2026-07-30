# syntax=docker/dockerfile:1

# =============================================================================
# GeoHistory API image
# =============================================================================
# Step 1.4 of the deployment plan: bake events.sqlite into an immutable image
# layer so the running service has no writable data dependency and no cold
# start. The dataset ships WITH the code, and a dataset change is a new image.
#
# IMPORTANT -- events.sqlite is gitignored (`*.sqlite`), so it is NOT in the
# repository. This image can only be built from a working copy that has a
# scored database present. That is deliberate: CI type-checks, humans build and
# deploy. See .github/workflows/deploy.yml.
#
# Build:
#   docker build -t geohistory-api .
# Run:
#   docker run --rm -p 8787:8787 geohistory-api
#   curl localhost:8787/v1/meta
# =============================================================================


# ---------------------------------------------------------------------------
# Stage 1: dependencies
# ---------------------------------------------------------------------------
# better-sqlite3 is a native module. Prebuilt binaries usually cover node:20 on
# linux/amd64, but the toolchain is installed anyway so the build cannot start
# silently depending on a prebuild that may not exist for the target platform.
FROM node:20-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

# NOTE: devDependencies are intentionally installed and carried into the runtime
# image. There is no build step -- the service runs TypeScript directly via
# `tsx server.ts` -- and tsx is currently a devDependency. Moving tsx into
# `dependencies` (or adding a tsc build) would let this be `--omit=dev` and drop
# roughly 30 MB. Tracked as a follow-up; not worth a package.json change inside
# the deployment PR.
RUN npm ci


# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

# tini gives the container a real init so SIGTERM reaches node and Fly's
# graceful shutdown does not hang for the full kill timeout.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    GEOHISTORY_DB=/app/events.sqlite

# node_modules is copied wholesale rather than reinstalled, so the compiled
# better-sqlite3 binary is the exact one built above against this same base
# image and architecture.
COPY --from=deps /app/node_modules ./node_modules

# Application sources. Listed explicitly rather than `COPY . .` so that adding a
# file to the repo cannot quietly enlarge the image or leak local artifacts --
# .dockerignore is the second line of defence, not the first.
COPY package.json ./
COPY tsconfig.json ./
COPY server.ts core.ts ./

# ---------------------------------------------------------------------------
# The dataset
# ---------------------------------------------------------------------------
# Mode 0444. The service is a read-only query surface: nothing in the request
# path writes to the database, and making that structurally impossible means a
# bug cannot corrupt the shipped dataset, only fail loudly.
#
# This requires server.ts to open the database with `readonly: true`. A
# read-write open against a 0444 file fails at startup, and better-sqlite3 will
# also refuse to set `journal_mode = WAL` on a read-only handle. If the
# container exits immediately with SQLITE_READONLY or SQLITE_CANTOPEN, that is
# this line talking -- fix the open flags rather than loosening the mode.
COPY --chmod=444 events.sqlite /app/events.sqlite

# Drop privileges. The `node` user ships with the base image as uid 1000.
USER node

EXPOSE 8787

# Node 20 has global fetch, so the healthcheck needs no curl in the image.
# /v1/health is the cheap endpoint -- it does not touch the database, which is
# what we want from a liveness probe. Readiness is /v1/meta, checked by the
# deploy workflow after a release.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "server.ts"]
