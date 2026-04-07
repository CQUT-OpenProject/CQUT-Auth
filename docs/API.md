# API

本文档说明当前 OIDC 服务对外暴露的接口、支持范围与接入约束。

能力边界见：[OIDC_PROFILE.md](./OIDC_PROFILE.md)

## 服务定位

- 当前仅提供 OpenID Connect Provider（`oidc-op`）
- 面向内部受控接入，不是开放生态通用 OP
- 仅支持白名单客户端
- `legacy /api/*` 已退役，统一返回 `404 Not Found`

## 基础约束

- `APP_ENV != test` 时，`OIDC_ISSUER`、回调地址、退出回跳地址必须使用 `https://`
- `APP_ENV = test` 时，仅允许 `http://localhost` 或 `http://127.0.0.1`
- 推荐流程：Authorization Code + PKCE
- PKCE 仅支持 `S256`
- 不支持隐式流和混合流

## Discovery

```http
GET /.well-known/openid-configuration
```

核心元数据包括：

- `issuer`
- `authorization_endpoint`
- `token_endpoint`
- `userinfo_endpoint`
- `jwks_uri`
- `end_session_endpoint`
- `response_types_supported=["code"]`
- `grant_types_supported=["authorization_code","refresh_token"]`
- `subject_types_supported=["public"]`
- `id_token_signing_alg_values_supported=["RS256"]`
- `code_challenge_methods_supported=["S256"]`

当前不会发布以下能力：

- Dynamic Client Registration
- Token Introspection
- Token Revocation
- Device Authorization Flow

## Authorization Endpoint

```http
GET /auth
```

支持：

- `response_type=code`
- `code_challenge_method=S256`
- `scope=openid profile email student offline_access`

说明：

- 交互页面由 OIDC 服务提供
- 生产入口的安全响应头由 Nginx 统一注入
- 交互表单包含 CSRF 校验

## Token Endpoint

```http
POST /token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded
```

支持：

- `grant_type=authorization_code`
- `grant_type=refresh_token`

约束：

- 机密客户端使用 `client_secret_basic`
- `redirect_uri` 必须与注册值精确匹配
- refresh token 默认启用 rotation，旧 token 重用会返回 `invalid_grant`

## UserInfo

```http
GET /userinfo
Authorization: Bearer <access_token>
```

返回 claims：

- `sub`
- `preferred_username`
- `name`
- `email`
- `email_verified`
- `status`

## JWKS

```http
GET /jwks
```

说明：

- 当前仅发布 `RS256` 公钥

## RP-Initiated Logout

```http
GET /session/end
```

可使用参数：

- `id_token_hint`
- `post_logout_redirect_uri`

约束：

- `post_logout_redirect_uri` 必须与客户端注册值精确匹配

## Demo 客户端

系统可自动注册 `demo-site` 示例客户端。

默认配置：

- `application_type=web`
- `token_endpoint_auth_method=client_secret_basic`
- 需要显式 consent

相关环境变量：

- `OIDC_DEMO_CLIENT_ENABLED`
- `OIDC_DEMO_CLIENT_ID`
- `OIDC_DEMO_CLIENT_SECRET`
- `OIDC_DEMO_REDIRECT_URI`
- `OIDC_DEMO_POST_LOGOUT_REDIRECT_URI`
