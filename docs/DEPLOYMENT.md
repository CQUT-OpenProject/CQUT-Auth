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

Compose 还为 `redis`、`postgres`、`auth-service`、`demo-site`、`nginx` 配置了 `healthcheck`，并通过 `depends_on.condition: service_healthy` 控制启动顺序，避免上游未就绪时反向代理抢先启动。

入口关系：

- `nginx` 监听宿主机 `80`
- `/` 重定向到 `/demo`
- `/demo` 反代到 `demo-site:3002`
- `/api/*` 反代到 `auth-service:3001/*`

## 环境文件

当前 compose 直接引用以下文件：

- [auth-service.env.example](/Users/uednd/code/CQUT-Auth/deploy/env/auth-service.env.example)
- [demo-site.env.example](/Users/uednd/code/CQUT-Auth/deploy/env/demo-site.env.example)

这意味着：

- 如果你直接运行 `docker compose up`，Compose 读取的就是这两个 example 文件
- 如果你不想直接修改 example 文件，需要自己改 `docker-compose.yml` 里的 `env_file` 指向

### auth-service 关键变量

```dotenv
APP_ENV=production
PORT=3001
DEDUPE_KEY_SECRET=change-me
CLIENT_ID=site_demo
CLIENT_SECRET=change-me
WORKER_MODE=external
REDIS_URL=redis://redis:6379
DATABASE_URL=postgres://postgres:postgres@postgres:5432/cqut_auth
LOG_LEVEL=info
AUTH_PROVIDER=mock
VERIFY_RATE_LIMIT_ENABLED=true
VERIFY_RATE_LIMIT_MAX=10
VERIFY_RATE_LIMIT_WINDOW_SECONDS=60
JOB_PAYLOAD_SECRET=change-me
WORKER_CONCURRENCY=5
JOB_MAX_ATTEMPTS=3
JOB_RETRY_BASE_MS=1000
PROVIDER_TIMEOUT_MS=10000
PROVIDER_TOTAL_TIMEOUT_MS=20000
STARTUP_STRICT_DEPENDENCIES=true
```

说明：

- `CLIENT_ID` / `CLIENT_SECRET` 是 auth-service 内置 demo client 凭据
- `WORKER_MODE=external` 表示 HTTP 服务不内联 worker，依赖独立 `auth-worker`
- `AUTH_PROVIDER=mock` 适合开发与演示
- 生产切换 CQUT 实接时应改为 `AUTH_PROVIDER=cqut`
- `JOB_PAYLOAD_SECRET` 必须替换为强随机值
- `STARTUP_STRICT_DEPENDENCIES=true` 时，当前运行模式要求的依赖缺失会导致启动失败

### demo-site 关键变量

```dotenv
PORT=3002
AUTH_SERVICE_BASE_URL=http://auth-service:3001
DEMO_CLIENT_ID=site_demo
DEMO_CLIENT_SECRET=change-me
```

说明：

- `DEMO_CLIENT_ID` / `DEMO_CLIENT_SECRET` 应与 auth-service 中配置的内置 demo client 一致
- 浏览器不会直接看到这两个值，它们只保留在 demo-site 服务端

## 本地 Docker 启动

在仓库根目录下执行：

```bash
cd deploy
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f auth-service
docker compose logs -f auth-worker
docker compose logs -f demo-site
docker compose logs -f nginx
```

## hosts 配置

当前 nginx 配置使用：

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

## 服务检查

### 检查 auth-service

```bash
curl http://verify.local/api/health/ready
```

预期类似：

```json
{
  "status": "ready",
  "env": "production",
  "worker_mode": "external",
  "provider": "mock",
  "database": "postgres",
  "redis": "ready"
}
```

如果依赖未满足，`/health/ready` 会返回 `503`，并在响应体中标记 `status: "not_ready"`。

### 检查 demo-site

```bash
curl -I http://verify.local/demo
```

应返回 `200`，并能在浏览器中看到 demo 页面。

## 生产 HTTPS 启动

生产环境建议使用独立的 HTTPS compose：

- [docker-compose.prod.yml](/Users/uednd/code/CQUT-Auth/deploy/docker-compose.prod.yml)

这套配置会：

- 监听 `80` 和 `443`
- 将 `http://auth.xxx.com/*` 自动跳转到 `https://auth.xxx.com/*`
- 暴露长期更清晰的入口：
  - `https://auth.xxx.com/demo`
  - `https://auth.xxx.com/api/health/ready`
  - `https://auth.xxx.com/api/verify`

准备项：

1. 将 TLS 证书放到 `deploy/certs/fullchain.pem` 和 `deploy/certs/privkey.pem`
2. 修改 [nginx.env.example](/Users/uednd/code/CQUT-Auth/deploy/env/nginx.env.example) 中的 `SERVER_NAME`
3. 如有需要，替换示例环境文件中的弱密钥

启动命令：

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

生产版 nginx 使用：

- [site.prod.conf.template](/Users/uednd/code/CQUT-Auth/deploy/nginx/site.prod.conf.template)

它会把 `/api/*` 转发给 `auth-service`，把 `/demo` 转发给 `demo-site`，并把根路径重定向到 `/demo`。

## 生产建议

- 仅暴露 nginx 入口，不直接暴露 `auth-service`、`demo-site`、`postgres`、`redis`
- 将 `DEDUPE_KEY_SECRET`、`CLIENT_SECRET`、`DEMO_CLIENT_SECRET` 替换为强随机值
- 将 `JOB_PAYLOAD_SECRET` 替换为强随机值
- 生产环境把 `AUTH_PROVIDER` 切到 `cqut`
- 根据业务量调整限流配置：
  - `VERIFY_RATE_LIMIT_ENABLED`
  - `VERIFY_RATE_LIMIT_MAX`
  - `VERIFY_RATE_LIMIT_WINDOW_SECONDS`
- 不要把浏览器账号密码、上游原始会话内容写入持久日志
- 为 PostgreSQL 和 Redis 配置持久化与备份策略

## 运维操作

重启服务：

```bash
docker compose restart auth-service
docker compose restart auth-worker
docker compose restart demo-site
```

重新构建单个服务：

```bash
docker compose build auth-service
docker compose build auth-worker
docker compose build demo-site
docker compose up -d auth-service auth-worker demo-site
```

停止并清理：

```bash
docker compose down
```

连同卷一起清理：

```bash
docker compose down -v
```

## 数据与持久化

Compose 默认启用了两个 volume：

- `redis_data`
- `postgres_data`

PostgreSQL 初始化脚本：

- [init-db.sql](../scripts/init-db.sql)

备份建议：

- PostgreSQL：`pg_dump`
- Redis：AOF/RDB + volume 级备份

## 常见问题

### 页面能打开，但验证失败

重点检查：

- `DEMO_CLIENT_ID` / `DEMO_CLIENT_SECRET` 是否与 auth-service 侧一致
- `AUTH_SERVICE_BASE_URL` 是否正确
- `AUTH_PROVIDER` 是否配置为你期望的 provider

### `429 rate_limited`

表示当前 `client_id` 在窗口期内超过阈值。可通过以下变量调整：

- `VERIFY_RATE_LIMIT_MAX`
- `VERIFY_RATE_LIMIT_WINDOW_SECONDS`

### `/health/ready` 返回 `503`

表示 auth-service 当前无法确认当前运行模式所需依赖已就绪。生产环境应先修复依赖连通性，再对外提供服务。
