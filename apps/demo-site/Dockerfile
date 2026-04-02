FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/demo-site ./apps/demo-site
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @cqut/demo-site build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/demo-site ./apps/demo-site
EXPOSE 3002
CMD ["node", "apps/demo-site/dist/main.js"]
