## Quick Overview

CQUT-Auth is an OpenID Connect (OIDC) Identity Provider bridging CQUT UIS/CAS authentication with client applications, featuring an admin console and Agent API.

- **Stack**: Node.js 24+, TypeScript (ESM, strict), Express 5, `oidc-provider`, PostgreSQL, Redis / In-memory, Jose
- **Frontend & Docs**: React 19 + Refine + Ant Design 5 + Vite 7 (`web/`), VitePress (`docs/`)
- **Package Manager & Runtime**: `pnpm` (10+) with Docker Compose
- **Structure**:
  - `src/`: Backend server (`main.ts`, `app.ts`), OIDC provider (`oidc/`), API routes (`routes/`), CAS identity (`identity/`), persistence & crypto (`persistence/`)
  - `web/`: Admin dashboard SPA
  - `docs/`: VitePress documentation site
  - `test/`: Integration & service tests; modular unit tests located near source (`*.test.ts`)
  - `deploy/` & `scripts/`: Deployment configurations (`docker-compose.yml`, `.env`) and maintenance scripts

## Commands & Workflow

- `pnpm install`: Install dependencies
- `pnpm dev`: Start both server and UI in dev mode (`dev:server`, `dev:ui`)
- `pnpm test`: Run all tests (`test:server` via Node test runner + `test:ui` via Vitest); run a single test: `npx tsx --test <path-to-test.ts>`
- `pnpm lint`: Run env source check (`scripts/check-single-env-source.mjs`) and TypeScript type check
- `pnpm build`: Build UI bundle and compile server TypeScript (`dist/`)
- `pnpm format`: Format codebase with Prettier
- `pnpm init-env --force --profile test`: Initialize local test environment configuration
- `pnpm docker:up` / `pnpm docker:down`: Start / stop local service stack with Docker Compose

## Write Code

- Plan first; do NOT rush to code.
- Strict TypeScript & ES Modules with 2-space indentation.
- Keep domain logic isolated in its corresponding module (`oidc/`, `identity/`, `persistence/`, `routes/`, `web/`).
- Read environment variables only through `src/config.ts` (enforced by `pnpm lint`).
- Never commit build artifacts (`dist/`, `docs/.vitepress/dist/`).
- Add regression tests for changes touching auth, persistence, security, or config. All tests must pass locally before completing tasks.

## Response Format

Be concise. Do not write unsolicited "WHY" explanations.

## Commit Convention

Use Gitmoji format: `<emoji> <concise Chinese>` (no `feat:`/`fix:` prefix). e.g., `✨ 新增客户端审核功能` or `🐛 修复 CAS 票据验证异常`.
