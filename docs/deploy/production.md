# 生产部署

## 1. 生成部署配置

```bash
pnpm install --frozen-lockfile
pnpm init-env --profile production --issuer https://auth.example.com
```

检查 `deploy/.env`，至少确认：

- `OIDC_ISSUER` 与外部 HTTPS 地址完全一致；
- `OIDC_COOKIE_SECURE=true`；
- `TRUST_PROXY_HOPS=1`；
- `TRUSTED_PROXY_CIDRS` 只包含实际反向代理来源；
- PostgreSQL 密码和各组安全密钥已妥善保存；
- `CQUT_UIS_BASE_URL`、`CQUT_CAS_APPLICATION_CODE` 和 `CQUT_CAS_SERVICE_URL` 符合当前 UIS 配置。

`init-env` 还会生成演示客户端。请在首次启动前检查 `deploy/oidc-clients.json` 的 Redirect URI 和 Scope；不需要引导客户端时，可以将 `clients` 改为空数组。

在生产模式下，缺少 PostgreSQL、关闭邮箱验证或 Artifact 清理、使用内存存储，或代理配置不完整，都会导致应用拒绝启动。标准生产部署还需要 Redis 且 `OIDC_RATE_LIMIT_FAIL_CLOSED=true`；单实例小部署见下文。

## 小部署（无 Redis）

用户量级不大、仅运行**单个**应用实例时，可启用小部署模式，用进程内内存限流替代 Redis：

```bash
pnpm init-env --profile production-small --issuer https://auth.example.com
```

确认 `deploy/.env` 中：

- `OIDC_SMALL_DEPLOYMENT=true`
- `REDIS_URL` 留空
- `OIDC_RATE_LIMIT_FAIL_CLOSED=false`

使用不含 Redis 的 Compose 启动：

```bash
docker compose -f deploy/docker-compose.prod-small.yml up -d --build
```

**取舍：**

- 限流计数保存在进程内存，**重启后清零**
- **不支持**多实例水平扩展（各实例计数不共享）
- 仍建议在前置反向代理层配置 fail2ban 或 IP 限流作为补充

若后续需要多实例或更严格的 fail-closed 语义，去掉 `OIDC_SMALL_DEPLOYMENT`、配置 `REDIS_URL` 并改回标准 `docker-compose.prod.yml` 即可。

## 2. 初始化签名密钥并启动

全新数据库必须先创建一把 OIDC 签名密钥。容器镜像不包含开发期的 `tsx` 和源码，因此首次容器部署可临时设置：

```dotenv
OIDC_AUTO_SEED_SIGNING_KEY=true
```

启动生产服务：

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

推送 `v*` 版本标签时，GitHub Actions 会构建 `linux/amd64`、`linux/arm64` 镜像并发布到 GitHub Container Registry（也可手动 `workflow_dispatch`）：

```bash
docker pull ghcr.io/cqut-openproject/cqut-auth:latest
```

例如 `v1.2.3` 会生成 `latest`、`v1.2.3`、`1.2.3`、`1.2`、`1` 和 `sha-<commit>` 标签。如果镜像包未设置为公开，拉取前需要先使用具有 `read:packages` 权限的 GitHub Token 登录 `ghcr.io`。

确认 `/health/live` 和 Discovery 正常后，将 `OIDC_AUTO_SEED_SIGNING_KEY` 改回 `false` 并重启。后续签名密钥由数据库管理，不需要每次启动重新生成。此时 `/health/ready` 仍可能因为邮件尚未配置而返回 `503`。

## 3. 配置反向代理

生产 Compose 默认只把应用绑定到宿主机 `127.0.0.1:3003`。反向代理应：

- 对外提供 HTTPS；
- 将 Host 和协议转发给应用；
- 覆盖而不是透传客户端提供的 `X-Forwarded-For`；
- 使应用看到的直连来源位于 `TRUSTED_PROXY_CIDRS`；
- 不直接暴露 PostgreSQL 和 Redis。

更换域名后不能只修改代理配置；必须同步更新 `OIDC_ISSUER`，并重新检查所有客户端 Redirect URI。

## 4. 建立管理员

1. 打开 `/manage`，使用学校账号登录；
2. 在管理后台复制当前 Subject ID；
3. 将该值加入 `OIDC_ADMIN_SUBJECT_IDS`，多个值用逗号分隔；
4. 重启服务并重新登录。

管理员可以审核客户端 Revision、管理全局运行策略、配置邮件通道并执行紧急处置。运行策略写入 PostgreSQL 后，需要重启服务才会生效。

完成邮件通道配置和测试后，确认 `/health/ready` 返回 `200 ready`，再将实例加入反向代理或负载均衡器的生产流量。
