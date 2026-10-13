# syntax=docker/dockerfile:1

# ---- deps: install all deps (better-sqlite3 is native) ----
FROM node:24-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./

# A TLS-intercepting proxy breaks `npm ci` with SELF_SIGNED_CERT_IN_CHAIN. Point
# npm at the proxy's CA bundle when one is mounted; without it, nothing changes.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then \
      cp /run/secrets/extra_ca /usr/local/share/extra-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/extra-ca.pem; \
    fi; \
    npm ci
COPY tsconfig*.json vite.config.ts ./
COPY src ./src

# ---- dev: `docker compose watch dev`. Compose syncs src/ in; tsx restarts the
# server and Vite hot-reloads the UI. Never the default target. ----
FROM deps AS dev
ENV CLAUDE_DIR=/claude \
    DATA_DIR=/data \
    HOST=127.0.0.1 \
    PORT=7878
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 5174
# The API stays on the container's loopback; only Vite (which proxies /api) is published.
CMD ["sh", "-c", "npx tsx watch src/server/main.ts & exec npx vite --host 0.0.0.0 --port 5174 --strictPort"]

# ---- build: compile server, bundle web ----
FROM deps AS build
RUN npm run build && npm prune --omit=dev

# ---- runtime: only production deps and built output ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    CLAUDE_DIR=/claude \
    DATA_DIR=/data \
    PORT=7878
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/server/main.js"]
