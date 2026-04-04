FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/demo-site ./apps/demo-site
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @cqut/demo-site build
RUN mkdir -p /deploy && pnpm --filter @cqut/demo-site --prod deploy --legacy /deploy/demo-site

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /deploy/demo-site ./
USER node
EXPOSE 3002
CMD ["node", "dist/main.js"]
