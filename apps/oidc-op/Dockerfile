FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/oidc-op ./apps/oidc-op
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @cqut/oidc-op build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/oidc-op ./apps/oidc-op
EXPOSE 3003
CMD ["node", "apps/oidc-op/dist/main.js"]
