# CQUT-Auth 协作说明

CQUT-Auth 是 CQUT UIS / CAS 的 OpenID Connect 身份提供方，包含管理后台与 Agent API。服务端使用 Express 5、`oidc-provider`、PostgreSQL 及 Redis / 内存存储；管理界面位于 `web/`，VitePress 文档位于 `docs/`。

## 开发环境与命令

- 本项目使用 [Vite+](https://viteplus.dev) 统一管理开发工具链，请勿使用其它工具进行管理。
- 使用 `.node-version` 固定的 Node.js 24.21.0、Vite+（`vp`）与项目锁定的 pnpm 10；用 `vp env current` 检查实际解析结果。本地服务依赖和环境配置按任务需要启用。
- `vp install` 安装依赖；`vp run dev` 启动服务端与管理界面开发流程。
- `vp check` 统一执行 Oxfmt、Oxlint、TypeScript 类型检查与环境变量读取边界检查。
- `vp test` 运行服务端与 UI 测试；可用 `vp test --project server` 或 `vp test --project web` 分别运行。
- `vp run build` 构建管理界面和服务端；`vp run docs:build` 构建文档。
- 仅在初始化测试环境时运行 `vp run init-env -- --profile test`。它会创建 `deploy/.env` 和 `deploy/oidc-clients.json`，并输出 demo client secret；如需覆盖现有文件，再明确加 `--force`。`vp run docker:up` / `vp run docker:down` 管理本地 Docker Compose 服务。

## 按任务查阅

- OIDC 与授权端点：`src/oidc/`、`src/routes/`；CAS 身份接入：`src/identity/`；持久化：`src/persistence/`；Agent API：`src/agent/`；管理界面：`web/`；用户文档：`docs/`。
- 服务端配置入口为 `src/config.ts`。改动配置时查看该文件和 `scripts/check-single-env-source.mjs`；不要在其他服务端模块直接读取环境变量。
- 修改认证、授权、持久化、安全或配置行为时，先查看对应实现及相邻测试，并补充覆盖新行为的回归测试。
- 涉及部署时再查看 `deploy/` 与 `scripts/`；普通代码改动不需要通读这些目录。

## 实现约束

- 使用严格 TypeScript 与 ESM，缩进两个空格；保持身份认证、OIDC、路由和持久化职责分别落在对应模块。
- 不提交 `dist/` 或 `docs/.vitepress/dist/` 构建产物。
- 不将真实凭据、令牌、Cookie 或用户数据写入源码、测试 fixture 或日志；测试使用合成数据。

## 验证

根据改动选择验证：通常运行 `vp check` 与相关测试；构建或文档变更时，再运行对应的 `vp run build` 或 `vp run docs:build`。报告实际运行的命令及未运行的检查。涉及环境变量配置时，确认 `vp run check:env-source` 通过。

## 提交信息

使用 Gitmoji 加简洁中文描述，例如：`✨ 新增客户端审核功能`、`🐛 修复 CAS 票据验证异常`。
