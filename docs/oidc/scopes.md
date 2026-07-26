# Scope 与 Claim

| Scope | Claim / 行为 |
| --- | --- |
| `openid` | `sub`。所有客户端 Revision 必须包含。 |
| `profile` | `preferred_username`、`name`。当前 `name` 为系统生成的占位名称。 |
| `email` | 仅在邮箱已验证时返回 `email` 和 `email_verified=true`。 |
| `student` | 返回 `status`；该字段不代表当前学籍。 |
| `offline_access` | 在客户端允许 Refresh Token 时请求离线访问。 |

::: warning
`student` Scope 返回的 `status=active` 只表示学校账号已通过 UIS / CAS 验证且本地 Subject 可用，**不代表**当前在读或具有有效学籍。依赖学籍状态的业务不应使用该字段作出决定。
:::
