# Deployment

本文档提供 OIDC 服务的完整部署教程，覆盖本地开发、测试联调与生产部署。

能力边界见：[OIDC_PROFILE.md](./OIDC_PROFILE.md)

## 部署内容

当前部署包含 4 个服务：

- `oidc-op`
- `postgres`
- `redis`
- `nginx`

说明：

- Demo 站点不在本仓部署范围内
- 示例站点需由 `CQUT-Auth-Demo` 仓单独部署

## 目录说明

- `deploy/.env.example`：环境变量模板
- `deploy/.env`：实际部署配置
- `deploy/docker-compose.yml`：本地 / 测试 Compose
- `deploy/docker-compose.prod.yml`：生产 HTTPS Compose
- `deploy/certs/`：TLS 证书目录
- `scripts/init-db.sql`：数据库初始化脚本

## 单一配置源约束

- OIDC 仓仅保留 `deploy/.env.example` 作为唯一环境模板来源
- 初始化与修改仅操作 `deploy/.env`（由 `deploy/.env.example` 派生）

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

- `production`：保留生产模板默认值，需手动补齐正式配置
- `local`：生成本地 HTTPS 联调配置，默认域名为 `verify.local`
- `test`：生成 loopback HTTP 测试配置，适合本地测试或 Docker 联调

补充参数：

- `--with-certs`：test 配置下也生成证书
- `--skip-certs`：跳过证书生成

注意：

- `init-env --force` 会重置 `POSTGRES_PASSWORD` 等随机密钥；若数据库卷仍保留旧密码，`oidc-op` 将无法连接数据库。
- 在测试/联调场景重新生成环境变量后，建议先执行 `docker compose -f deploy/docker-compose.yml down -v` 再 `up -d --build`，确保容器与凭据一致。

## 关键环境变量

最少需要关注：

```dotenv
APP_ENV=production
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<random-secret>
POSTGRES_DB=cqut_auth
OIDC_ISSUER=https://auth.example.com:8443
OIDC_HTTP_PORT=80
OIDC_HTTPS_PORT=8443
OIDC_COOKIE_SECURE=true
OIDC_KEY_ENCRYPTION_SECRET=<random-secret>
OIDC_ARTIFACT_ENCRYPTION_SECRET=<random-secret>
OIDC_COOKIE_KEYS=<random-secret>,<random-secret>
OIDC_CSRF_SIGNING_SECRET=<random-secret>
OIDC_CLIENTS_CONFIG_PATH=/app/config/oidc-clients.json
CQUT_UIS_BASE_URL=https://uis.cqut.edu.cn
CQUT_CAS_APPLICATION_CODE=officeHallApplicationCode
CQUT_CAS_SERVICE_URL=https://uis.cqut.edu.cn/ump/common/login/authSourceAuth/auth?applicationCode=officeHallApplicationCode
SERVER_NAME=auth.example.com
TLS_CERT_PATH=/etc/nginx/certs/fullchain.pem
TLS_KEY_PATH=/etc/nginx/certs/privkey.pem
```

必须遵守：

- `OIDC_ARTIFACT_ENCRYPTION_SECRET` 必须不同于 `OIDC_KEY_ENCRYPTION_SECRET`
- 生产环境下以上密钥应使用高熵随机值，且长度不少于 32 字符
- 业务站客户端必须在 `deploy/oidc-clients.json` 中配置
- `APP_ENV=production` 时必须启用外部 `postgres` 与 `redis`
- `APP_ENV=production` 时不得使用内存存储

端口补充：

- `OIDC_HTTP_PORT` 默认 `80`，用于映射 nginx 的 `80` 端口
- `OIDC_HTTPS_PORT` 默认 `8443`，用于映射 nginx 的 `443` 端口（生产 compose）
- 若宿主机端口已占用，可改为其他端口（例如 `OIDC_HTTP_PORT=8080`），并同步更新 `OIDC_ISSUER`

## 数据库初始化

数据库结构统一由下列脚本维护：

```bash
scripts/init-db.sql
```

如果需要手工初始化数据库：

```bash
psql -U postgres -d cqut_auth -f scripts/init-db.sql
```

说明：

- 脚本包含当前 OIDC 所需表、扩展与定时清理任务
- 当前项目未上线，测试环境字段改动时，直接删除并重建数据库容器即可

## 本地开发部署

适用场景：

- 本地 HTTPS 联调
- 浏览器直接访问 `verify.local`

步骤：

1. 生成本地配置

```bash
pnpm init-env --force --profile local
```

2. 准备本地域名解析

```text
127.0.0.1 verify.local
```

3. 启动服务

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

4. 验证服务

```bash
curl -k https://verify.local/.well-known/openid-configuration
```

若改过 `OIDC_HTTP_PORT` / `OIDC_HTTPS_PORT`，请按实际端口访问。

本地入口：

- `https://verify.local/.well-known/openid-configuration`
- `https://verify.local/auth`

## 测试部署

适用场景：

- loopback HTTP 测试
- 与 `CQUT-Auth-Demo` Docker 联调

步骤：

1. 生成测试配置

```bash
pnpm init-env --force --profile test
```

2. 启动服务

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

3. 验证服务

```bash
curl http://127.0.0.1/.well-known/openid-configuration
```

若设置了 `OIDC_HTTP_PORT`（例如 `8080`），请改为 `curl http://127.0.0.1:8080/.well-known/openid-configuration`。

测试入口：

- `http://127.0.0.1/.well-known/openid-configuration`
- `http://127.0.0.1/auth`

## 生产部署

适用场景：

- 公网 HTTPS
- 真实证书
- 正式域名

步骤：

1. 生成或编写生产配置

```bash
pnpm init-env --force --profile production
```

2. 编辑 `deploy/.env`

必须确认：

- `OIDC_ISSUER` 为正式 HTTPS 地址
- `SERVER_NAME` 与证书域名一致
- 所有密钥均已替换为正式随机值
- Demo 回调地址为正式地址

3. 准备证书

将证书放到：

- `deploy/certs/fullchain.pem`
- `deploy/certs/privkey.pem`

4. 启动服务

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

5. 验证服务

```bash
curl https://auth.example.com:8443/.well-known/openid-configuration
```

## 运行检查

查看服务状态：

```bash
docker compose -f deploy/docker-compose.yml ps
```

查看日志：

```bash
docker compose -f deploy/docker-compose.yml logs -f oidc-op
docker compose -f deploy/docker-compose.yml logs -f nginx
```

健康检查：

- `oidc-op`：`/health/live`
- `oidc-op`：`/health/ready`

## 与 Demo 联调

如果要与 `CQUT-Auth-Demo` 一起联调，推荐使用 `test` 配置。

OIDC 侧：

```bash
pnpm init-env --force --profile test
docker compose -f deploy/docker-compose.yml up -d --build
```

要求：

- `OIDC_ISSUER=http://127.0.0.1`
- `deploy/oidc-clients.json` 中 `redirectUris` 使用 `http://localhost:3002/callback`
- `deploy/oidc-clients.json` 中 `postLogoutRedirectUris` 使用 `http://localhost:3002/logout-complete`

说明：

- 浏览器入口与回调主机名必须一致
- 如果 Demo 用 `localhost:3002` 打开，回调也必须是 `localhost:3002`

## 常见问题

`/token` 返回 `invalid_client`

- 检查 `client_id` / `client_secret`
- 检查客户端是否使用 `client_secret_basic`
- 检查 Demo 与 OIDC 的客户端配置是否一致（`deploy/oidc-clients.json` 与 Demo 应用配置）

`/token` 返回 `invalid_grant`

- 检查 `redirect_uri` 是否精确匹配
- 检查授权码是否重复使用
- 检查 PKCE verifier 是否正确

发现旧数据影响测试

- 直接执行容器重建并删除卷
- 当前测试环境不保留数据

本地 HTTPS 无法访问

- 检查 `verify.local` 是否解析到本机
- 检查证书是否已生成到 `deploy/certs/`

登录时报 `campus upstream request timed out`

- 先在部署机检查连通性：
  - `curl -I --max-time 20 https://uis.cqut.edu.cn/center-auth-server/cas/login`
- 代码仅使用 `uis` 的 `officeHallApplicationCode` CAS 入口
- 可通过 `CQUT_UIS_BASE_URL` / `CQUT_CAS_APPLICATION_CODE` / `CQUT_CAS_SERVICE_URL` 覆盖上游地址与入口（适配网关或代理）
