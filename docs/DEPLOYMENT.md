# Deployment

本文档说明当前 OIDC 服务的部署方式。重构后本仓只负责以下三类容器：

- `oidc-op`
- `postgres`
- `redis`

TLS 终止不再由本仓处理。生产环境必须由仓外的反向代理、负载均衡或网关负责 HTTPS，并将请求转发到本仓 `oidc-op` 暴露的 HTTP 端口。

能力边界见：[OIDC_PROFILE.md](./OIDC_PROFILE.md)

## 目录说明

- `deploy/.env.example`：环境变量模板
- `deploy/.env`：实际部署配置
- `deploy/docker-compose.yml`：本地 / 测试 Compose
- `deploy/docker-compose.prod.yml`：生产 Compose（仍只暴露 HTTP upstream）
- `deploy/oidc-clients.json.example`：客户端配置模板
- `docker/postgres/Dockerfile`：带 `pg_cron` 的 PostgreSQL 镜像
- `scripts/init-db.sql`：数据库初始化脚本

## 单一配置源约束

- OIDC 仓仅保留 `deploy/.env.example` 作为唯一环境模板来源
- 初始化与修改仅操作 `deploy/.env`
- 当前项目未上线，测试环境字段变更时直接删除并重建容器即可，不编写迁移脚本

## 环境准备

需要安装：

- Docker
- Docker Compose
- Node.js 24+
- pnpm 10+

首次进入仓库后执行：

```bash
pnpm install
```

## 一键生成环境变量

项目提供环境初始化脚本：

```bash
pnpm init-env --force --profile <production|local|test>
```

说明：

- `production`：生成面向仓外 HTTPS 反代的默认配置
- `local`：生成适合本地 HTTPS 反代联调的默认配置，默认 issuer 为 `https://verify.local`
- `test`：生成 loopback HTTP 测试配置，默认 issuer 为 `http://127.0.0.1:3003`

补充参数：

- `--issuer <https://auth.example.com>`：覆盖生成的 `OIDC_ISSUER`
- `--demo-base-url <https://demo.example.com>`：同步生成 `deploy/oidc-clients.json` 中的登录回调与登出回跳地址

注意：

- `init-env --force` 会重置 `POSTGRES_PASSWORD` 等随机密钥；若数据库卷仍保留旧密码，`oidc-op` 将无法连接数据库
- 在测试或联调场景重新生成环境变量后，建议先执行 `docker compose -f deploy/docker-compose.yml down -v` 再 `up -d --build`
- 本脚本不再生成 TLS 证书，也不再管理证书目录

## 关键环境变量

最少需要关注：

```dotenv
APP_ENV=production
OIDC_ISSUER=https://auth.example.com
OIDC_APP_PORT=3003
TRUST_PROXY_HOPS=1
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<random-secret>
POSTGRES_DB=cqut_auth
OIDC_COOKIE_SECURE=true
OIDC_KEY_ENCRYPTION_SECRET=<random-secret>
OIDC_ARTIFACT_ENCRYPTION_SECRET=<random-secret>
OIDC_COOKIE_KEYS=<random-secret>,<random-secret>
OIDC_CSRF_SIGNING_SECRET=<random-secret>
OIDC_CLIENTS_CONFIG_PATH=/app/config/oidc-clients.json
OIDC_AUTO_SEED_SIGNING_KEY=false
CQUT_UIS_BASE_URL=https://uis.cqut.edu.cn
CQUT_CAS_APPLICATION_CODE=officeHallApplicationCode
CQUT_CAS_SERVICE_URL=https://uis.cqut.edu.cn/ump/common/login/authSourceAuth/auth?applicationCode=officeHallApplicationCode
```

必须遵守：

- `OIDC_ARTIFACT_ENCRYPTION_SECRET` 必须不同于 `OIDC_KEY_ENCRYPTION_SECRET`
- 非测试环境下上述密钥应使用高熵随机值，且长度不少于 32 字符
- 业务站客户端必须在 `deploy/oidc-clients.json` 中配置
- 首次部署若尚未手工执行 `pnpm seed:key`，可临时设置 `OIDC_AUTO_SEED_SIGNING_KEY=true` 让服务在启动时自动补种签名密钥
- `APP_ENV=production` 时不得使用内存存储
- 生产环境应由仓外 HTTPS 入口转发请求到本机 `OIDC_APP_PORT`

## 数据库初始化

数据库结构统一由下列脚本维护：

```bash
scripts/init-db.sql
```

如需手工初始化数据库：

```bash
psql -U postgres -d cqut_auth -f scripts/init-db.sql
```

## 本地 / 测试部署

测试 HTTP 场景：

```bash
pnpm init-env --force --profile test
docker compose -f deploy/docker-compose.yml up -d --build
curl http://127.0.0.1:3003/.well-known/openid-configuration
```

本地 HTTPS 联调场景：

1. 生成本地配置

```bash
pnpm init-env --force --profile local
```

2. 在宿主机或外部反代上为 `https://verify.local` 做 TLS 终止，并转发到 `http://127.0.0.1:3003`

3. 启动服务

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

4. 验证服务

```bash
curl http://127.0.0.1:3003/health/ready
```

## 生产部署

步骤：

1. 生成生产配置

```bash
pnpm init-env --force --profile production --issuer https://auth.example.com
```

2. 编辑 `deploy/.env`，填入正式密钥、数据库口令、Resend 配置

3. 在宿主机或外部入口层配置 HTTPS，将公网 `https://auth.example.com` 转发到 `http://127.0.0.1:${OIDC_APP_PORT}`

4. 启动生产栈

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

## 健康检查与排障

常用命令：

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f oidc-op
docker compose -f deploy/docker-compose.yml logs -f postgres
docker compose -f deploy/docker-compose.yml logs -f redis
```

健康检查接口：

- `oidc-op`：`/health/live`
- `oidc-op`：`/health/ready`

常见排查点：

- 检查 `OIDC_ISSUER` 是否与真实对外访问地址一致
- 检查仓外反代是否正确覆盖 `X-Forwarded-*`
- 检查 Demo 与 OIDC 的客户端配置是否一致
- 重新生成 env 后若数据库密码变更，先执行 `down -v` 再重建容器
