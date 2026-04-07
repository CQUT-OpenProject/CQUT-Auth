# OIDC 能力边界（CQUT Profile）

`oidc-op` 是一个面向内部受控接入的 OpenID Connect Provider 精简 profile。
它不是面向开放生态的通用 OP，也不承诺兼容任意第三方 OIDC 场景。

## 定位

- 类型：OIDC Core 精简实现
- 主流程：Authorization Code + PKCE
- 服务对象：内部系统、受控客户端、白名单接入方
- 非目标：开放注册、开放接入、全量 OIDC 互操作

## 已支持能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Discovery | 支持 | `/.well-known/openid-configuration` |
| Authorization Endpoint | 支持 | 仅 `response_type=code` |
| PKCE | 支持 | 仅 `S256`，且必须启用 |
| Token Endpoint | 支持 | `authorization_code`、`refresh_token` |
| Refresh Token Rotation | 支持 | 旧 token 重用返回 `invalid_grant` |
| UserInfo | 支持 | 返回精简 claims |
| JWKS | 支持 | 当前发布 `RS256` 公钥 |
| Subject Type | 支持 | 仅 `public` |
| RP-Initiated Logout | 支持 | `post_logout_redirect_uri` 必须精确匹配 |

## 不支持能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Dynamic Client Registration | 不支持 | 不在 discovery 中发布 |
| Token Introspection | 不支持 | 不在 discovery 中发布 |
| Token Revocation | 不支持 | 不在 discovery 中发布 |
| Device Authorization Flow | 不支持 | 不在 discovery 中发布 |
| Implicit Flow | 不支持 | `response_type` 非 `code` 会被拒绝 |
| Hybrid Flow | 不支持 | 当前不开放 |
| Pairwise Subject Identifier | 不支持 | 仅支持 `public` subject |

## 接入约束

- 仅允许受控客户端接入
- 客户端需要预注册
- 不提供第三方自助接入
- 机密客户端默认使用 `client_secret_basic`
- 回调地址与退出回跳地址必须使用注册值精确匹配

## 非目标

当前阶段不做以下事情：

- 构建面向全生态的通用 OP
- 支持任意第三方客户端自助注册
- 提供在线 token introspection 服务
- 支持设备码登录
- 支持更复杂的 subject 隔离模型

## 未来扩展条件

只有在明确业务需要时，才考虑扩展：

- 多资源服务器需要在线验 token 时，再引入 introspection
- 合规要求立即撤销 token 时，再引入 revocation
- 需要大规模第三方接入时，再引入动态注册
- 出现无浏览器登录场景时，再引入 device flow
- 需要跨 RP 隐私隔离时，再评估 pairwise subject
