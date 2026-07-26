# 项目介绍

CQUT Auth 是为受控客户端提供登录服务的 OpenID Connect Provider。它通过重庆理工大学 UIS / CAS 验证学校账号，将验证结果关联到本地 Subject，再通过 Authorization Code + PKCE 向已审核的客户端签发令牌。

项目还提供客户端管理后台，可管理项目成员和 OIDC 客户端，配置 Redirect URI、Scope 与 Client Secret，并处理审核和运行策略。

::: danger
本项目会在登录期间接收学校账号和密码，并将其用于请求 UIS；凭据不会写入数据库。部署者仍需自行完成安全评审、日志审计、网络隔离、密钥管理和隐私合规。请勿将未经审计的实例直接用于生产环境。
:::

## 特别感谢

[「CQUT校园网登录脚本」](https://github.com/coldriver-chen/cqut-net-login) 公开的重要信息，作为本项目的基座。本项目在其基础上进行了进一步的逆向分析与改进。

## 能力与边界

- OIDC Authorization Code 流程，强制 PKCE；支持 Web 和 SPA 客户端。
- `openid`、`profile`、`email`、`student`、`offline_access` Scope。
- UIS / CAS 登录、Service Ticket 校验和学校身份关联。
- 使用 PostgreSQL 保存 Subject、客户端、授权、签名密钥、管理会话和审计记录。
- 使用 Redis 限流；生产环境中限流服务不可用时会拒绝请求。
- Web 客户端 Secret 仅展示一次，以 scrypt 摘要保存，并支持宽限期轮换和指定撤销。
- 支持客户端 Revision 审核、项目成员权限管理和管理员紧急处置。
- 支持邮箱验证；邮件、时效、限流和配额策略可在管理后台调整。
- 支持 Refresh Token 轮换、客户端授权 Generation 和过期 Artifact 清理。

当前**不支持**动态客户端注册、Client Credentials、Device Flow、Introspection、标准 Revocation Endpoint 或 Implicit Flow。所有客户端均由管理后台或首次部署配置创建并审核。

`student` Scope 返回的 `status=active` 只表示学校账号已通过 UIS / CAS 验证且本地 Subject 可用，**不代表**当前在读或具有有效学籍。依赖学籍状态的业务不应使用该字段作出决定。

## 环境要求

- Node.js 24 或更高版本
- pnpm 10 或更高版本
- Docker Engine 与 Docker Compose v2
- 可访问 `uis.cqut.edu.cn`
- 生产环境需要可用的 HTTPS 域名和反向代理
