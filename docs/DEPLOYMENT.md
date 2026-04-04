# Deployment

部署后的公开形态：

- `oidc-op` 作为统一对外认证入口
- `demo-site` 作为 OIDC RP 示例站
- `redis` + `postgres` 作为基础依赖

legacy `/api/*` 已退役，Nginx 统一返回 `404 Not Found`。

## Compose 拓扑

当前 Compose 启动：

- `oidc-op`
- `demo-site`
- `redis`
- `postgres`
- `nginx`

Nginx 路由：

- `/` -> `/demo`
- `/.well-known/*` -> `oidc-op`
- `/auth` `/token` `/userinfo` `/jwks` `/session/*` `/interaction/*` -> `oidc-op`
- `/demo/*` -> `demo-site`
- `/api` 与 `/api/*` -> `404`

## 关键环境变量

### OIDC OP

```dotenv
PORT=3003
OIDC_ISSUER=https://auth.xxx.com
OIDC_COOKIE_SECURE=true
OIDC_KEY_ENCRYPTION_SECRET=<set-in-deploy-env>
OIDC_COOKIE_KEYS=<set-in-deploy-env>,<set-in-deploy-env>
OIDC_SESSION_TTL_SECONDS=28800
OIDC_SESSION_IDLE_TTL_SECONDS=7200
OIDC_INTERACTION_TTL_SECONDS=900
OIDC_REFRESH_TTL_SECONDS=2592000
OIDC_DEMO_CLIENT_ID=demo-site
OIDC_DEMO_CLIENT_SECRET=<set-in-deploy-env>
OIDC_DEMO_REDIRECT_URI=https://auth.xxx.com/demo/callback
OIDC_DEMO_POST_LOGOUT_REDIRECT_URI=https://auth.xxx.com/demo
```

说明：

- `OIDC_ISSUER` 必须是公网浏览器可访问地址
- `OIDC_KEY_ENCRYPTION_SECRET` 用于加密私钥 JWK
- `OIDC_COOKIE_KEYS` 用于 OP cookie 签名，支持多 key 轮换

### demo-site

```dotenv
PORT=3002
OIDC_ISSUER=https://auth.xxx.com
OIDC_DISCOVERY_URL=http://oidc-op:3003/.well-known/openid-configuration
OIDC_DEMO_CLIENT_ID=demo-site
OIDC_DEMO_CLIENT_SECRET=<set-in-deploy-env>
DEMO_BASE_URL=https://auth.xxx.com
```

说明：

- `OIDC_ISSUER` 决定浏览器重定向目标
- `OIDC_DISCOVERY_URL` 用于容器内抓取 discovery；如果它与 `OIDC_ISSUER` 不同，demo-site 会带上公网 Host/Proto 头，确保 discovery 产出的端点仍是公网地址

## 数据库说明

`scripts/init-db.sql` 仅保留当前 OIDC 链路需要的表结构，不再初始化 legacy auth-service 表。

若是存量数据库，需要手动执行一次性清理脚本：

```sql
\i scripts/migrations/drop-legacy-auth-service.sql
```

该脚本会幂等删除历史 legacy 表：

- `verification_jobs`
- `verification_requests`
- `clients`

## 本地 Docker

```bash
cd deploy
cp .env.example .env
docker compose --env-file .env up -d --build
```

hosts 增加：

```text
127.0.0.1 verify.local
```

本地入口：

- `http://verify.local/.well-known/openid-configuration`
- `http://verify.local/demo`
- `http://verify.local/api`（预期 404）

## 生产 HTTPS

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml up -d --build
```

准备项：

1. 配置 `deploy/.env`
2. 准备 TLS 证书到 `deploy/certs/fullchain.pem` 与 `deploy/certs/privkey.pem`
3. 确认 `OIDC_ISSUER` 与 `SERVER_NAME` 对应同一个公网地址

## 运行与排障

查看日志：

```bash
docker compose --env-file deploy/.env logs -f oidc-op
docker compose --env-file deploy/.env logs -f demo-site
```

健康检查：

- `oidc-op`: `/health/live`, `/health/ready`
- `demo-site`: `/demo`

常见问题：

- discovery 里的 `authorization_endpoint` 指向了内网地址：检查 `OIDC_ISSUER`、`OIDC_DISCOVERY_URL`、Nginx 转发 Host 头
- `/token` 返回 `invalid_grant`：确认 `redirect_uri` 精确匹配、PKCE verifier 正确、授权码未复用
- demo-site 登录后又回到未登录：检查 `DEMO_BASE_URL`、cookie Secure 设置与反代 `X-Forwarded-Proto`
