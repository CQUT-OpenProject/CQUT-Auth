# 安全说明

- 不记录账号密码、CAS Ticket、门户 Ticket 或 `authServerToken`。
- 生产环境必须启用 HTTPS 和安全 Cookie，校验可信代理；标准部署在 Redis 限流不可用时拒绝请求，小部署（`OIDC_SMALL_DEPLOYMENT=true`）使用进程内内存限流。
- 各组加密密钥、Cookie 密钥和 CSRF 密钥必须独立生成并妥善备份。
- 不要把 `deploy/.env`、明文 Client Secret 或私钥提交到仓库。
- 管理 API 使用独立 HttpOnly 会话和 CSRF Token；反向代理不应缓存相关响应。
- Client Secret 明文只出现一次；轮换前应确认使用方已经准备切换。
- 邮件配置严格校验 SMTP 服务端主机名，生产环境阻断云厂商元数据地址（`169.254.169.254` 等）与内网回环以防范 SSRF。
- 定期备份 PostgreSQL，并验证签名密钥和加密密钥能够恢复。

::: warning
本项目会在登录期间接收学校账号和密码并用于请求 UIS。部署者需自行完成安全评审、日志审计、网络隔离、密钥管理和隐私合规。
:::
