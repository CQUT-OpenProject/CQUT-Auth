<div align="center">
  <h1>CQUT Auth</h1>
  <p>面向重庆理工大学统一身份认证的专属 OpenID Connect (OIDC) Provider</p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Node.js](https://img.shields.io/badge/Node.js-24+-green.svg)](https://nodejs.org/)
  [![pnpm](https://img.shields.io/badge/pnpm-10+-orange.svg)](https://pnpm.io/)
</div>

<br/>

> [!NOTE]
>
> 本项目大部分代码、测试和文档均由智能体编写。维护者仅对体感功能进行简单测试，对数据安全与代码质量不作任何保障，但我们会尽最大努力修复问题。

## ✨ 特性 (Features)

- **🏫 无缝对接校园认证**：将学校 UIS / CAS 登录链路安全包装为标准 OIDC 登录入口。
- **🔐 标准协议支持**：完整支持 Authorization Code + PKCE 流程，签发高可靠 ID / Access Token。
- **🎛️ 受控白名单接入**：非开放生态 OP，需在通过 JSON 文件预注册客户端域与凭证，实现严格的安全边界。
- **🛡️ 生产级安全防护**：内置交互页 CSRF 校验、端点及登录限流、Refresh Token Rotation、Artifact 自动清理。
- **📧 邮箱验证引擎**：原生内置 Resend 邮件服务支持，保障用户的实名绑定链路。
- **📦 现代化技术栈**：搭配 PostgreSQL 持久化与 Redis 高缓存，基于 Node.js 24 无缝构建。

## 🏗️ 原理与架构 (Architecture)

CQUT Auth 不存储学校的账号密码，亦不强行替代业务站的原始用户系统。它在 OIDC 协议和学校登录链路间建立了一座信任代理桥梁：业务站发起标准登录请求，随后用户在受控沙箱向学校系统进行身份验证；验证通过后，服务将对应凭据映射为本地 Subject，向业务终端下放 Token。

整个流程由四个逻辑核心层组成：

1. **入口层**：外部 HTTPS 代理（如 Nginx）处理 TLS 连接与业务卸载。
2. **协议层**：实现核心的 OIDC 通信逻辑端点 (`/auth`, `/token`, `/userinfo`, `/jwks`, `/session/end`)。
3. **身份层**：负责下发鉴权表单，转接 CQUT UIS / CAS 的交互，并完成邮件、会话等上下文映射。
4. **存储层**：利用 PostgreSQL 沉淀稳定数据，依赖 Redis 提供高频瞬态防护能力（限流与会话隔离）。

```mermaid
sequenceDiagram
    autonumber
    participant User as 用户浏览器
    participant RP as 业务站 / OIDC Client
    participant OP as CQUT Auth
    participant UIS as CQUT UIS / CAS
    participant DB as PostgreSQL
    participant Cache as Redis

    User->>RP: 访问需要登录的页面
    RP->>User: 跳转到 /auth，携带 client_id、redirect_uri、scope、PKCE
    User->>OP: 打开 OIDC 授权交互页
    OP->>DB: 校验客户端、回调地址与 OIDC 参数
    OP->>Cache: 写入交互状态、CSRF 与限流状态
    User->>OP: 提交学校账号、密码与 CSRF token
    OP->>UIS: 使用学校登录链路验证账号密码
    UIS-->>OP: 返回登录结果与学校身份
    OP->>DB: 绑定或更新本地用户，写入授权码
    OP-->>User: 302 跳回业务站 redirect_uri?code=...
    User->>RP: 携带授权码回到业务站
    RP->>OP: POST /token，提交授权码、client_secret、code_verifier
    OP->>DB: 校验授权码、客户端密钥、PKCE 并生成 token
    OP-->>RP: 返回 ID Token、Access Token 与可选 Refresh Token
    RP->>OP: GET /userinfo，使用 Access Token 获取用户资料
    OP-->>RP: 返回受 scope 与邮箱验证状态约束的 claims
```

## 🚀 快速开始 (Getting Started)

### 前置依赖 (Prerequisites)

- [Node.js](https://nodejs.org/) v24+
- [pnpm](https://pnpm.io/) v10+
- [Docker](https://www.docker.com/) 20.10+ & [Compose](https://docs.docker.com/compose/) v2+

### 一键启动

1. **获取代码并安装依赖**

   ```bash
   pnpm install
   ```

2. **本地测试环境 (HTTP)**

   ```bash
   # 初始化测试环境，自动配置内置 demo 客户端
   pnpm init-env --force --profile test
   
   # 启动后端中间件集群
   docker compose -f deploy/docker-compose.yml up -d --build
   
   # 等待启动并检测健康状态
   curl http://127.0.0.1:3003/health/ready
   curl http://127.0.0.1:3003/.well-known/openid-configuration
   ```

   *注意：使用 `--force` 将抹除先前的加密轮数并覆写预置信息。如若数据库中保留了早期密码可能会发生鉴权拒绝，推荐执行 `docker compose -f deploy/docker-compose.yml down -v` 彻底洗卷。*

3. **本地开发联调网络 (HTTPS)**
   适用于由宿主机或网关代理终止 TLS 的场景：

   ```bash
   pnpm init-env --force --profile local --issuer https://verify.local
   docker compose -f deploy/docker-compose.yml up -d --build
   ```

## 🛠️ 部署指南 (Deployment)

推荐的拓扑是由您自己控制的反向代理暴露对外 HTTPS 入口，通过 Compose 打包发布服务集群。

```bash
# 生成供正式使用的 env 安全模板
pnpm init-env --force --profile production --issuer https://auth.example.com
    
# 以后台常驻唤起
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

**🚨 生产上线前检查清单：**

- [ ] `OIDC_ISSUER` 必须与外场可达的 HTTPS 域名完全对齐。
- [ ] `OIDC_COOKIE_SECURE=true`、`TRUST_PROXY_HOPS=1` 与 `TRUSTED_PROXY_CIDRS` 配置完毕，反向代理必须覆盖 `X-Forwarded-For`。
- [ ] 项目中涉及的各套秘钥组（Cookie / 加密 / Redis 等）均已更改为高熵值。
- [ ] `RESEND_API_KEY` 及 `OIDC_EMAIL_FROM` 已正确就绪以实现邮箱鉴权下行。
- [ ] OIDC 终端客户端已在 `deploy/oidc-clients.json` 中配置完毕并映射。
- [ ] 初次启动可通过设定 `OIDC_AUTO_SEED_SIGNING_KEY=true` （或命令执行）完成签名私钥分发。
- [ ] 确保 `APP_ENV=production` 环境下正确连接到了非易失形态的 PostgreSQL 与 Redis 实例。

## 🔌 接入文档 (Integration)

### 基本安全要求

- 当前环境下拒绝 Implicit 以及部分混合模式，强校验 **Authorization Code + PKCE (`S256`)** 协议流。
- 正式环境下回调及回溯域必须通过 `https://` 约束，严防劫持。

### 客户端注册示范

暂未开放动态注册（Dynamic Register）能力，支持对本地 JSON 做增列并随着容器下发。默认路径侦听位置在 `/app/config/oidc-clients.json` 处。

<details>
<summary><code>oidc-clients.json</code> 范例</summary>

```json
{
  "clients": [
	    {
	      "clientId": "demo-site",
	      "clientSecretDigest": "scrypt$N=16384,r=8,p=1,keylen=32$<base64url-salt>$<base64url-digest>",
	      "grantTypes": ["authorization_code", "refresh_token"],
	      "scopeWhitelist": ["openid", "profile", "email", "student"],
	      "redirectUris": ["https://demo.example.com/callback"],
	      "postLogoutRedirectUris": ["https://demo.example.com/logout-complete"],
	      "autoConsent": false
    }
  ]
}
```
	
	</details>

`offline_access` 是显式 opt-in scope，不在默认 `scopeWhitelist` 内。`tokenEndpointAuthMethod="none"` 的 public client 默认只允许 `authorization_code`；如确需向 public client 签发 refresh token，必须同时显式配置 `grantTypes` 包含 `refresh_token`、`scopeWhitelist` 包含 `offline_access`，并设置 `allowRefreshTokenForPublicClient: true`。

`student` scope 只增加 `status` claim。当前 `status=active` 表示该账号已通过学校 UIS/CAS 认证且可在本 OP 中使用，不代表“当前在读学生”身份；RP 不应据此推断学籍状态。

### OIDC 核心端点映射表

| 功能区 | 端点 URI | 操作详述 |
| :--- | :--- | :--- |
| **Discovery** | `GET /.well-known/openid-configuration` | 获取服务支持的签名算法与节点映射表。 |
| **Authorize** | `GET /auth` | 重定向登入，允许附带客户端白名单内的 `openid profile email student offline_access` 域。 |
| **Token** | `POST /token` | basic auth/form 模式签发/转结令牌；Public Client 默认不签发 Refresh Token。 |
| **UserInfo** | `GET /userinfo` | 校验 Access 以查询 User 字段。注意 `邮箱` 相关数据仅过审可返回。|
| **Logout** | `GET /session/end` | 注销全域登录状态（应附 `id_token_hint`及回溯）。 |
| **JWKS** | `GET /jwks` | 提供用于客户端对端强验证的 RSA-256 (RS256) 公钥串。 |

## 🧑‍💻 常用指令 (Scripts)

```bash
# 进入调试/开发状态
pnpm dev
# 执行核心套件检查
pnpm test
pnpm lint
pnpm build

# 服务数据辅助操作
pnpm seed:key      # 为 OIDC 补种 RSA 签名池
pnpm seed:client   # 将文件上的 Clients 信息下灌进入持久化表
```

## 🛡️ 能力边界 (Limitations)

本项目主诉为**微型内聚的单一 Provider**，不考虑全量 OIDC 范式覆盖。

**已内置的功能：**

- Discovery、JWKS、UserInfo
- 严密安全标准的 Code + PKCE
- Refresh Token 旋转与回收
- 服务端发起的 (RP-Initiated) 会话截断

**暂无预期的功能（规划外）：**

- 动态应用注册 (Dynamic Registration) 与回收销毁验证
- 设备层授权流 (Device Auth Flow)
- 隐式流与杂凑流 (Implicit / Hybrid OIDC)
- 复杂的 Pairwise ID 等隐私隔离模型

## 📄 许可证 (License)

本项目基于 [MIT License](LICENSE) 通用协议授权。
