FROM public.ecr.aws/docker/library/node:24-alpine AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts

RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm prune --prod

FROM public.ecr.aws/docker/library/node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

USER node
EXPOSE 3003
CMD ["node", "dist/main.js"]
