# Scope 与 Claim

| Scope            | 返回内容或行为                                                          |
| ---------------- | ----------------------------------------------------------------------- |
| `openid`         | 返回 `sub`。每个客户端配置都必须包含此 Scope。                          |
| `profile`        | 返回 `preferred_username` 和 `name`。`name` 格式为 `User-<schoolUid>`。 |
| `email`          | 邮箱验证后返回 `email` 和 `email_verified: true`。                      |
| `student`        | 返回 `status`。此字段不表示当前学籍。                                   |
| `offline_access` | 客户端允许 Refresh Token 时，可请求离线访问。                           |

::: warning
`student` Scope 返回的 `status=active` 只表示学校账号已通过 UIS / CAS 验证且本地 Subject 可用，**不代表**当前在读或具有有效学籍。依赖学籍状态的业务不应使用该字段作出决定。
:::

邮箱未验证时，服务器不会返回 `email` 或 `email_verified`。SPA 客户端不能申请 `offline_access`。客户端的 Scope 白名单还必须包含 `openid`。
