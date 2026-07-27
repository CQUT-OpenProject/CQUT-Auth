# 开发

## 常用命令

```bash
pnpm dev            # 监听服务端和管理后台构建
pnpm test           # 运行服务端与前端测试
pnpm test:server    # 仅运行 Node.js / tsx 测试
pnpm test:ui        # 仅运行 Vitest 前端测试
pnpm lint           # 检查环境变量来源和 TypeScript 类型
pnpm build          # 构建服务端与管理后台到 dist/
pnpm format         # 使用 Prettier 格式化仓库
pnpm docs:dev       # 本地预览文档站
pnpm docs:build     # 构建文档站静态产物
```

指定服务端测试：

```bash
pnpm exec tsx --test test/crypto.test.ts
```

`pnpm dev` 从 `deploy/.env` 读取配置。需要 PostgreSQL 和 Redis 时，可直接使用开发 Compose；容器会挂载当前工作区并运行监听构建。

## 提交前检查

```bash
pnpm lint
pnpm test
pnpm build
```

## 项目结构

| 路径                                     | 说明                            |
| ---------------------------------------- | ------------------------------- |
| `src/oidc/`、`src/routes/`、`src/app.ts` | OIDC 协议与 HTTP                |
| `src/identity/`                          | 身份认证集成                    |
| `src/persistence/`                       | 持久化、仓储、加密和限流        |
| `web/`                                   | 管理后台前端                    |
| `docs/`                                  | 文档站（VitePress）             |
| `test/`                                  | 服务测试与集成测试              |
| `deploy/`                                | Docker Compose 与客户端配置示例 |
