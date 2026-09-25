# 端点与流程

## 端点

| 端点                                    | 用途                   |
| --------------------------------------- | ---------------------- |
| `GET /.well-known/openid-configuration` | Discovery              |
| `GET /auth`                             | Authorization Endpoint |
| `POST /token`                           | Token Endpoint         |
| `GET /userinfo`                         | UserInfo Endpoint      |
| `GET /jwks`                             | 签名公钥               |
| `GET /session/end`                      | RP-Initiated Logout    |

Discovery 文档会公布当前 Issuer、端点和支持的能力。客户端应从 `/.well-known/openid-configuration` 获取端点，不要在代码中固定域名。

## 流程要求

- 使用 Authorization Code + PKCE `S256`。
- Web 客户端使用 `client_secret_basic`。
- SPA 是公开客户端，不生成 Client Secret；默认不向公开客户端签发 Refresh Token。
- Redirect URI 必须与已审核配置精确匹配。
- `openid` 是必需 Scope。客户端只能请求其 Scope 白名单中的范围。
- 令牌时效和可用 Scope 以 Discovery 文档及客户端审核配置为准。

## 不支持的能力

- 动态客户端注册
- Client Credentials
- Device Flow
- Introspection
- 标准 Revocation Endpoint
- Implicit Flow

所有客户端均由管理后台或首次部署配置创建并审核。
