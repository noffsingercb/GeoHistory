# syntax=docker/dockerfile:1

# =============================================================================
# GeoHistory API image
# =============================================================================
# The dataset is baked into an immutable image layer, so the running service has
# no writable data dependency, no volume, and no load step at boot. A dataset
# change is a new image -- nothing mutates in place.
#
# WHERE THE DATASET COMES FROM
# events.sqlite is gitignored (`*.sqlite`) and lives on a workstation, so it is
# not in the repository and never will be. Rather than require it in the build
# context -- which would mean only a machine holding the database could build --
# the image DOWNLOADS it from the public GitHub release. Any host that builds
# from the repo alone (Render, Fly, a CI runner) can therefore produce a working
# image with no manual upload.
#
# Publish the dataset once:
#   gh release create dataset-latest events.sqlite --title "Dataset"
# Refresh it later, reusing the tag:
#   gh release upload dataset-latest events.sqlite --clobber
#
# Build and run locally:
#   docker build -t geohistory-api .
#   docker run --rm -p 8787:8787 geohistory-api
#   curl localhost:8787/v1/meta
# =============================================================================


# ---------------------------------------------------------------------------
# Stage 1: the dataset
# ---------------------------------------------------------------------------
FROM node:20-slim AS dataset

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# DATASET_VERSION does nothing but change this layer's cache key. Uploading a
# new asset to the same release tag leaves the curl command byte-identical, so
# without a bump here a cached layer would ship an old database forever. Set it
# to whatever the new dump is stamped with, or pass --build-arg at build time.
ARG DATASET_VERSION=dump-v0.5+struct-v0.6+reach-v0.2+prune3
ARG DATASET_URL=https://github.com/noffsingercb/GeoHistory/releases/download/dataset-latest/events.sqlite

WORKDIR /data

# Validated here rather than at startup. A missing release returns an HTML 404
# page, and a dropped connection returns a truncated file; both would sail
# through the build and then fail inside better-sqlite3 with an error that says
# nothing about the real cause. Checking the size and the magic header costs
# nothing and fails at the point where the mistake was made.
RUN echo "Fetching dataset ${DATASET_VERSION}" \
 && curl -fL --retry 3 --retry-delay 2 -o events.sqlite "${DATASET_URL}" \
 && size=$(stat -c%s events.sqlite) \
 && echo "events.sqlite: ${size} bytes" \
 && if [ "$size" -lt 1000000 ]; then \
      echo "ERROR: events.sqlite is implausibly small (${size} bytes)."; \
      echo "ERROR: is there a 'dataset-latest' release with an events.sqlite asset?"; \
      exit 1; \
    fi \
 && header=$(head -c 15 events.sqlite) \
 && if [ "$header" != "SQLite format 3" ]; then \
      echo "ERROR: not a SQLite database (header: '${header}')."; \
      exit 1; \
    fi \
 && chmod 444 events.sqlite


# ---------------------------------------------------------------------------
# Stage 2: dependencies
# ---------------------------------------------------------------------------
# better-sqlite3 is a native module. Prebuilt binaries usually cover node:20 on
# linux/amd64, but the toolchain is installed anyway so the build cannot start
# silently depending on a prebuild that may not exist for the target platform.
FROM node:20-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

# NOTE: devDependencies are intentionally installed and carried into the runtime
# image. There is no build step -- the service runs TypeScript directly via
# `tsx server.ts` -- and tsx is currently a devDependency. Moving tsx into
# `dependencies` (or adding a tsc build) would let this be `--omit=dev` and drop
# roughly 30 MB. Tracked as a follow-up.
RUN npm ci


# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

# tini gives the container a real init so SIGTERM reaches node and a graceful
# shutdown does not hang for the full kill timeout.
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
# Mode 0444, set in the dataset stage and preserved by this copy. The service is
# a read-only query surface: nothing in the request path writes to the database,
# and making that structurally impossible means a bug cannot corrupt the shipped
# dataset, only fail loudly.
#
# This requires server.ts to open the database with `readonly: true`. A
# read-write open against a 0444 file fails at startup, and better-sqlite3 will
# also refuse to set `journal_mode = WAL` on a read-only handle. If the
# container exits immediately with SQLITE_READONLY or SQLITE_CANTOPEN, that is
# this line talking -- fix the open flags rather than loosening the mode.
COPY --from=dataset /data/events.sqlite /app/events.sqlite

# Drop privileges. The `node` user ships with the base image as uid 1000.
USER node

EXPOSE 8787

# Node 20 has global fetch, so the healthcheck needs no curl in the image.
# /v1/health is the cheap endpoint -- it does not touch the database, which is
# what we want from a liveness probe. Readiness is /v1/meta.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "server.ts"]
