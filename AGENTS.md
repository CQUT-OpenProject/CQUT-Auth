# Repository Guidelines

## 项目结构与模块组织

- `src/` 存放应用代码。OIDC 协议与 HTTP 相关逻辑位于 `src/oidc/`、`src/routes/` 和 `src/app.ts`；身份认证集成位于 `src/identity/`；持久化、仓储、加密和限流逻辑位于 `src/persistence/`。
- `test/` 存放服务测试和集成测试；针对单个模块的测试也可以放在源码旁，例如 `src/identity/providers/*.test.ts`。
- `scripts/` 存放数据库和环境初始化脚本。`deploy/` 存放 Docker Compose 文件及客户端配置示例，`docker/` 存放辅助镜像配置。
- 构建产物写入 `dist/`，不得提交到仓库。

## 构建、测试与开发命令

使用 Node.js 24+、pnpm 10+ 和 Docker Compose。

```bash
pnpm install                         # 安装锁定版本的依赖
pnpm dev                             # 使用 tsx watch 模式启动服务
pnpm test                            # 运行全部测试
pnpm lint                            # 检查环境变量来源规则和 TypeScript 类型
pnpm build                           # 将编译产物输出到 dist/
pnpm format                          # 使用 Prettier 格式化仓库
pnpm init-env --force --profile test # 生成本地测试环境配置
pnpm docker:up                       # 构建并启动本地服务栈
pnpm docker:down                     # 停止本地服务栈
```

针对单个模块迭代时，可使用 `pnpm test -- test/crypto.test.ts` 运行指定测试。

## 编码风格与命名约定

使用严格模式的 TypeScript、ES Modules 和两个空格缩进。变量和函数使用 `camelCase`，类、类型和接口使用 `PascalCase`，描述性文件名使用 kebab-case。将领域逻辑保留在对应模块中。提交前运行 `pnpm format` 和 `pnpm lint`；项目没有单独的 ESLint 配置。

## 测试规范

测试使用 Node.js 测试运行器、`tsx` 和 Supertest。测试文件命名为 `*.test.ts`，将较大型的集成测试放在 `test/`，将针对单个实现的单元测试放在源码附近。涉及认证、持久化、安全或配置的改动应补充回归测试。项目未设置明确的覆盖率门槛，但所有测试必须在本地通过。

## 提交与 Pull Request 规范

提交信息使用 emoji 前缀、中文编写、保持简洁、根据变更类型选择：

| 变更类型          | Emoji |
| ----------------- | ----- |
| 新功能 (`feat`)   | ✨    |
| 修复 (`fix`)      | 🐛    |
| 文档 (`docs`)     | 📝    |
| 样式 (`style`)    | 💄    |
| 重构 (`refactor`) | ♻️    |
| 性能 (`perf`)     | ⚡️    |
| 测试 (`test`)     | ✅    |
| 杂务 (`chore`)    | 🔧    |
| 构建 (`build`)    | 📦    |
| CI (`ci`)         | 💚    |
| 回滚 (`revert`)   | ⏪    |
