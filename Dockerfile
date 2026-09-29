# syntax=docker/dockerfile:1

# ---------- dependencies ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# Toolchain is only a fallback for native modules without a prebuilt binary; it never reaches the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm build \
  # Tracing may pull in TypeScript sources; the runtime only needs compiled output and migrations.
  && rm -rf .next/standalone/src .next/standalone/tests .next/standalone/docs

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runtime
# git: clone/fetch of repository connections. tini: PID 1 signal handling and zombie reaping.
# Security updates are applied at build time, and package managers the runtime never uses (npm, npx, corepack,
# yarn) are removed so their dependency trees cannot carry vulnerabilities into the image.
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Build metadata, set by the release workflow and recorded as OCI labels and environment variables.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="stack-manager" \
      org.opencontainers.image.description="Git-native source workspace for self-hosted Compose stacks" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STACK_MANAGER_DATA_DIR=/data \
    STACK_MANAGER_VERSION=${APP_VERSION} \
    STACK_MANAGER_GIT_SHA=${GIT_SHA}

WORKDIR /app
# Application files stay root-owned (read-only for the service user); only /data is writable.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/drizzle ./drizzle

RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
# Migrations run automatically at startup (src/instrumentation.ts → boot()).
CMD ["node", "server.js"]
