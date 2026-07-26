# 本地启动

以下配置用于本地功能测试，不应作为生产配置：

```bash
pnpm install
pnpm init-env --profile test
pnpm docker:up
```

`init-env` 会生成：

- `deploy/.env`：包含随机数据库密码、加密密钥、Cookie 密钥和 CSRF 密钥；
- `deploy/oidc-clients.json`：包含一个演示客户端及其 scrypt Secret 摘要。

命令会在终端输出一次演示客户端明文 Secret。请立即保存；配置文件和数据库中均无法恢复该明文。

## 默认服务地址

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:3003/manage` | 客户端管理后台 |
| `http://127.0.0.1:3003/.well-known/openid-configuration` | OIDC Discovery |
| `http://127.0.0.1:3003/health/live` | 进程存活检查 |
| `http://127.0.0.1:3003/health/ready` | PostgreSQL、Redis 和邮件状态检查 |

邮箱验证默认启用。在管理员完成邮件通道配置前，`/health/ready` 会返回 `503 degraded` 和 `email: unconfigured`；这不妨碍打开管理后台完成首次配置。

## 停止服务

```bash
pnpm docker:down
```

如果目标文件已存在，`init-env` 会拒绝覆盖。只有明确需要重新生成密钥和演示客户端时才使用 `--force`；覆盖后，旧数据中的密文和 Cookie 可能无法继续使用。
