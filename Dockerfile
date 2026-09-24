# Dev target: full install (incl. devDependencies) for Vite+ hot reload.
# Source is bind-mounted at runtime; only node_modules is baked in so the
# compose anonymous volume can seed a Linux-native install over the Windows host.
FROM ghcr.io/voidzero-dev/vite-plus:0.3.3 AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
RUN vp install --frozen-lockfile --prod=false
EXPOSE 3003
CMD ["vp", "run", "dev"]

FROM ghcr.io/voidzero-dev/vite-plus:0.3.3 AS builder
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
RUN vp install --frozen-lockfile
COPY --chown=vp:vp tsconfig.json tsconfig.build.json vite.config.ts ./
COPY --chown=vp:vp src ./src
COPY --chown=vp:vp web ./web
COPY --chown=vp:vp scripts ./scripts
RUN vp run build
RUN cp "$(vp env which node | head -1)" /tmp/node

FROM ghcr.io/voidzero-dev/vite-plus:0.3.3 AS deps
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
RUN vp install --frozen-lockfile --prod

FROM debian:bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /tmp/node /usr/local/bin/node
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY openapi ./openapi

USER nobody
EXPOSE 3003
CMD ["node", "dist/main.js"]
