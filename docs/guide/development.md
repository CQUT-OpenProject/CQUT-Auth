# 开发

## 开发环境

本项目使用 [Vite+](https://viteplus.dev) 统一管理开发工具链，请勿使用其它工具进行管理。

项目使用 Vite+ 统一管理 Node.js、pnpm、Vite、Vitest、Oxlint 和 Oxfmt：

```bash
vp env current # 查看当前项目解析出的 Node.js 与 pnpm
vp env install # 安装 .node-version 与 packageManager 声明的环境
vp install     # 按 pnpm-lock.yaml 安装依赖
```

`.node-version` 固定日常开发、CI 和容器构建使用的 Node.js 24.21.0；`package.json` 的 `engines.node` 声明应用支持 Node.js 24 及以上版本。升级 Node.js 时应先修改 `.node-version`，再完整运行下方检查。

## 常用命令

```bash
vp run dev               # 监听服务端和管理后台构建
vp test                  # 运行服务端与前端测试
vp test --project server # 仅运行服务端测试
vp test --project web    # 仅运行管理后台测试
vp run check             # 格式、lint、类型和环境来源检查
vp run build             # 构建服务端与管理后台到 dist/
vp fmt                   # 使用 Oxfmt 格式化仓库
vp run docs:dev          # 本地预览文档站
vp run docs:build        # 构建文档站静态产物
```

指定服务端测试：

```bash
vp test test/crypto.test.ts
```

`vp run dev` 从 `deploy/.env` 读取配置。需要 PostgreSQL 和 Redis 时，可直接使用开发 Compose；容器会挂载当前工作区并运行监听构建。

PostgreSQL 集成测试仅在设置 `TEST_DATABASE_URL` 时运行；未设置时 Vitest 会明确跳过该 suite：

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  vp test --project server
```

管理后台生产构建使用 Vite 8 / Rolldown 的 `codeSplitting.groups` 拆分 React、Ant Design、Refine 等依赖。调整依赖或分包规则后，运行 `vp run build:ui` 并确认没有大 chunk 警告。

## 提交前检查

```bash
vp check
vp test
vp run build
```

仓库的 `.vite-hooks/pre-commit` 会对暂存文件运行 `vp staged`。首次 clone 后执行 `vp hooks enable` 安装 dispatcher；可用 `vp hooks status` 检查状态。

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
