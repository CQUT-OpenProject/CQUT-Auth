# Deployment

本文档覆盖当前仓库的部署与联调方式，基于：

- [docker-compose.yml](../deploy/docker-compose.yml)
- [docker-compose.prod.yml](../deploy/docker-compose.prod.yml)
- [nginx/site.conf](../deploy/nginx/site.conf)
- [nginx/site.prod.conf.template](../deploy/nginx/site.prod.conf.template)

## 拓扑

Docker Compose 当前会启动：

- `auth-service`
- `auth-worker`
- `demo-site`
- `redis`
- `postgres`
- `nginx`

入口关系：

- `nginx` 监听宿主机 `80`
- `/` 重定向到 `/demo`
- `/demo` 反代到 `demo-site:3002`
- `/api/*` 反代到 `auth-service:3001/*`

## 环境文件

当前 compose 统一读取：

- [deploy/.env.example](../deploy/.env.example)

使用方式：

1. 复制 `deploy/.env.example` 为未跟踪的 `deploy/.env`
2. 在 `deploy/.env` 中填入真实 secret、数据库口令和域名
3. 在 `deploy/` 目录执行 `docker compose --env-file .env ...`

也可以直接生成一份随机 secret 完整版：

```bash
pnpm generate:env
```

如果只想预览输出而不写文件：

```bash
pnpm generate:env:stdout
```

### auth-service 关键变量

```dotenv
APP_ENV=production
PORT=3001
AUTH_PROVIDER=mock
WORKER_MODE=external
WORKER_INLINE_ENABLED=false
STARTUP_STRICT_DEPENDENCIES=true
REDIS_URL=redis://redis:6379
DEDUPE_KEY_SECRET=<set-in-deploy-env>
JOB_PAYLOAD_SECRET=<set-in-deploy-env>
DEMO_CLIENT_ENABLED=true
CLIENT_ID=site_demo
CLIENT_SECRET=<set-in-deploy-env>
VERIFY_RATE_LIMIT_ENABLED=true
VERIFY_RATE_LIMIT_MAX=10
VERIFY_RATE_LIMIT_WINDOW_SECONDS=60
WORKER_CONCURRENCY=5
JOB_MAX_ATTEMPTS=3
JOB_RETRY_BASE_MS=1000
PROVIDER_TIMEOUT_MS=10000
PROVIDER_TOTAL_TIMEOUT_MS=20000
CORS_ALLOWED_ORIGINS=https://auth.example.com
TRUST_PROXY_HOPS=1
```

说明：

- `DEDUPE_KEY_SECRET` / `CLIENT_SECRET` / `JOB_PAYLOAD_SECRET` 必须使用强随机值
- `DEMO_CLIENT_ENABLED` 在生产必须显式为 `true` 才会注册 demo client
- `WORKER_MODE=external` 表示 HTTP 服务不内联 worker，依赖独立 `auth-worker`
- `/health/ready` 在 `WORKER_MODE=external` 下要求独立 `auth-worker` 心跳存在
- `STARTUP_STRICT_DEPENDENCIES=true` 时，当前运行模式要求的依赖缺失会导致启动失败
- 默认关闭跨域，只有确有浏览器直连需求时才配置 `CORS_ALLOWED_ORIGINS`

### demo-site 关键变量

```dotenv
PORT=3002
AUTH_SERVICE_BASE_URL=http://auth-service:3001
DEMO_CLIENT_ENABLED=true
CLIENT_ID=site_demo
CLIENT_SECRET=<set-in-deploy-env>
```

说明：

- 生产环境必须显式设置 `DEMO_CLIENT_ENABLED=true`
- `CLIENT_ID` / `CLIENT_SECRET` 应与 auth-service 中配置的内置 demo client 一致
- 浏览器不会直接看到这两个值，它们只保留在 demo-site 服务端

### 数据库相关变量

```dotenv
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<set-in-deploy-env>
POSTGRES_DB=cqut_auth
```

Compose 会根据这些变量为 `auth-service` 和 `auth-worker` 拼接 `DATABASE_URL`，仓库内不再跟踪可直接复用的连接串。

## 本地 Docker 启动

```bash
cd deploy
cp .env.example .env
docker compose --env-file .env up -d --build
```

查看状态：

```bash
docker compose --env-file .env ps
```

查看日志：

```bash
docker compose --env-file .env logs -f auth-service
docker compose --env-file .env logs -f auth-worker
docker compose --env-file .env logs -f demo-site
docker compose --env-file .env logs -f nginx
```

## hosts 配置

当前开发版 nginx 配置使用：

```nginx
server_name verify.local;
```

因此需要在本机 hosts 中加入：

```text
127.0.0.1 verify.local
```

访问地址：

- `http://verify.local/api/health/ready`
- `http://verify.local/demo`

## 生产 HTTPS 启动

生产环境建议使用独立的 HTTPS compose：

- [docker-compose.prod.yml](../deploy/docker-compose.prod.yml)

准备项：

1. 将 TLS 证书放到 `deploy/certs/fullchain.pem` 和 `deploy/certs/privkey.pem`
2. 复制 [deploy/.env.example](../deploy/.env.example) 为 `deploy/.env`
3. 在 `deploy/.env` 中填入真实域名、数据库口令和全部 secret

启动命令：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml up -d --build
```

## 生产建议

- 仅暴露 nginx 入口，不直接暴露 `auth-service`、`demo-site`、`postgres`、`redis`
- 将 `POSTGRES_PASSWORD`、`DEDUPE_KEY_SECRET`、`CLIENT_SECRET`、`JOB_PAYLOAD_SECRET` 替换为强随机值
- 生产环境把 `AUTH_PROVIDER` 切到 `cqut`
- 按需调整限流配置：
  - `VERIFY_RATE_LIMIT_ENABLED`
  - `VERIFY_RATE_LIMIT_MAX`
  - `VERIFY_RATE_LIMIT_WINDOW_SECONDS`
- 不要把浏览器账号密码、上游原始会话内容写入持久日志
- 为 PostgreSQL 和 Redis 配置持久化与备份策略

## 运维操作

重启服务：

```bash
docker compose --env-file deploy/.env restart auth-service auth-worker demo-site
```

重新构建服务：

```bash
docker compose --env-file deploy/.env build auth-service auth-worker demo-site
docker compose --env-file deploy/.env up -d auth-service auth-worker demo-site
```

停止并清理：

```bash
docker compose --env-file deploy/.env down
```

连同卷一起清理：

```bash
docker compose --env-file deploy/.env down -v
```

## 常见问题

### 页面能打开，但验证失败

重点检查：

- `DEMO_CLIENT_ENABLED` 是否开启
- `CLIENT_ID` / `CLIENT_SECRET` 是否与 auth-service 侧一致
- `AUTH_SERVICE_BASE_URL` 是否正确
- `AUTH_PROVIDER` 是否配置为你期望的 provider

### `429 rate_limited`

表示当前 `client_id + source_ip` 在窗口期内超过阈值。可通过以下变量调整：

- `VERIFY_RATE_LIMIT_MAX`
- `VERIFY_RATE_LIMIT_WINDOW_SECONDS`

### `/health/ready` 返回 `503`

表示 auth-service 当前无法确认当前运行模式所需依赖已就绪。生产环境应先修复依赖连通性，再对外提供服务。
