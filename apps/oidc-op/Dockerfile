FROM public.ecr.aws/docker/library/node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/oidc-op ./apps/oidc-op
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @cqut/oidc-op build
RUN mkdir -p /deploy && pnpm --filter @cqut/oidc-op --prod deploy --legacy /deploy/oidc-op

FROM public.ecr.aws/docker/library/node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /deploy/oidc-op ./
USER node
EXPOSE 3003
CMD ["node", "dist/main.js"]
