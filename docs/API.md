# API

当前仓库对外公开 OpenID Connect Provider 与 OIDC 示例 RP：

- `oidc-op`: 标准 OpenID Connect Provider
- `demo-site`: OIDC 登录示例站

legacy `/api/*` 已退役，统一返回 `404 Not Found`。

## OIDC OP

基础信息：

- 默认本地地址：`http://localhost:3003`
- 推荐公网地址：`https://auth.xxx.com`

### Discovery

```http
GET /.well-known/openid-configuration
```

MVP 公开的关键元数据：

- `issuer`
- `authorization_endpoint`
- `token_endpoint`
- `userinfo_endpoint`
- `jwks_uri`
- `response_types_supported=["code"]`
- `grant_types_supported=["authorization_code","refresh_token"]`
- `subject_types_supported=["public"]`
- `id_token_signing_alg_values_supported=["RS256"]`
- `code_challenge_methods_supported=["S256"]`

### Authorization Endpoint

```http
GET /auth
```

仅支持：

- `response_type=code`
- `code_challenge_method=S256`
- `scope` 取值：`openid profile email student offline_access`

首次登录流程：

1. 浏览器跳转 `/auth`
2. OP 跳转 `/interaction/:uid`
3. 用户输入校园账号密码
4. 若本地 profile 缺邮箱，则跳转 `/interaction/:uid/profile`
5. OP 自动完成 consent，返回 `code`

### Token Endpoint

```http
POST /token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded
```

支持：

- `grant_type=authorization_code`
- `grant_type=refresh_token`

refresh token 默认启用 rotation，旧 refresh token 重用会返回 `invalid_grant`。

### UserInfo Endpoint

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
- `school`
- `student_status`

说明：

- `sub` 使用内部永久 `subject_id`
- `email_verified` 在当前版本始终为 `false`

### JWKS

```http
GET /jwks
```

当前仅发布 `RS256` 签名公钥。

### RP-Initiated Logout

```http
GET /session/end
```

可携带：

- `id_token_hint`
- `post_logout_redirect_uri`

## demo-site

当前公开路由：

- `GET /demo`
- `GET /demo/login`
- `GET /demo/callback`
- `GET /demo/logout`
