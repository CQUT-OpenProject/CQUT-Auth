# 配置说明

`deploy/.env.example` 是部署期配置模板。以下变量决定应用能否安全启动：

| 变量                              | 说明                                                      |
| --------------------------------- | --------------------------------------------------------- |
| `APP_ENV`                         | `production`、`development` 或 `test`                     |
| `OIDC_ISSUER`                     | 对外 Issuer；非测试环境必须使用 HTTPS                     |
| `DATABASE_URL`                    | 应用使用的 PostgreSQL URL，由 Compose 根据数据库变量组装  |
| `REDIS_URL`                       | Redis URL；标准生产必需；小部署可留空                     |
| `OIDC_SMALL_DEPLOYMENT`           | 单实例小部署；`true` 时允许生产环境无 Redis、使用内存限流 |
| `OIDC_RATE_LIMIT_FAIL_CLOSED`     | 限流后端不可用时拒绝请求；无 Redis 的小部署必须为 `false` |
| `OIDC_KEY_ENCRYPTION_SECRET`      | 数据库签名私钥加密密钥                                    |
| `OIDC_ARTIFACT_ENCRYPTION_SECRET` | OIDC Artifact 载荷加密密钥，必须与前者不同                |
| `OIDC_COOKIE_KEYS`                | Cookie 签名密钥列表，可按顺序轮换                         |
| `OIDC_CSRF_SIGNING_SECRET`        | CSRF Token 签名密钥                                       |
| `TRUST_PROXY_HOPS`                | 生产环境固定为一层可信代理                                |
| `TRUSTED_PROXY_CIDRS`             | 允许提供转发 IP 的代理来源 CIDR                           |
| `OIDC_ADMIN_SUBJECT_IDS`          | 管理员 Subject ID 白名单                                  |
| `OIDC_AUTO_SEED_SIGNING_KEY`      | 是否在无签名密钥时自动初始化，生产常态应为 `false`        |
| `OIDC_AGENT_API_ENABLED`          | 是否启用 `/api/agent` REST 入口；生产默认 `false`         |
| `CQUT_UIS_BASE_URL`               | UIS 基础地址                                              |
| `CQUT_CAS_APPLICATION_CODE`       | CAS 应用代码                                              |
| `CQUT_CAS_SERVICE_URL`            | CAS Ticket 绑定的 Service URL                             |

## 管理后台配置

邮件发送参数、Token 和会话时效、验证码策略、业务限流及项目配额都在管理后台的「系统设置」中维护。启动时会忽略对应的旧环境变量，不应再用它们配置这些项目。

## 引导客户端

`deploy/oidc-clients.json` 只在客户端表为空时执行一次引导导入。数据库已有客户端后，修改该文件不会更新现有记录。
