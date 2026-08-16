# CQUT Auth 客户端管理入口

通过 REST Agent API 帮用户管理 OIDC 项目、成员与客户端。

- **Base URL**：`{{baseUrl}}`
- **OpenAPI**：`GET {{baseUrl}}/openapi.json`（端点与 schema 以此为准）
- **认证**：Bearer Token；**不需要** CSRF

---

## 工作流

复制 checklist，逐步完成：

```
- [ ] 1. 理解用户需求，必要时 GET /projects 确认目标项目
- [ ] 2. 向用户索取重庆理工大学账号密码（仅可信环境）
- [ ] 3. POST /auth/login → 保存 accessToken
- [ ] 4. 执行 API 操作（变更前先 GET 取版本号）
- [ ] 5. 汇总结果；若有 clientSecret 立即交付用户
- [ ] 6. POST /auth/logout
```

---

## 认证

```http
POST /auth/login
Content-Type: application/json

{ "account": "<学号>", "password": "<密码>" }
```

后续请求：

```http
Authorization: Bearer <accessToken>
```

---

## 请求路由

**新建项目？** → `POST /projects` `{ "name": "..." }`

**注册客户端？** → `POST /projects/:projectId/clients`

**改 redirect URI / scope？** → `GET .../clients/:clientId` → `PUT .../revision`

**改显示名 / 描述？** → `PATCH .../clients/:clientId`

**加成员？** → `POST .../members`

**轮换 Secret？** → `GET client` → `POST .../secrets/rotate`

---

## 客户端注册

`POST /projects/:projectId/clients` 必填：

| 字段             | 值                            |
| ---------------- | ----------------------------- |
| `clientType`     | `web`（机密）或 `spa`（公开） |
| `displayName`    | 显示名称                      |
| `redirectUris`   | 至少一个                      |
| `scopeWhitelist` | 须含 `openid`                 |

Scope：`openid`、`profile`、`email`、`student`、`offline_access`

- SPA：`requirePkce` 强制 `true`；不可申请 `offline_access`
- Web：创建/轮换时返回 `clientSecret`，**仅一次**

---

## 乐观锁

变更前 GET 取版本，请求体携带：

- 项目：`expectedProjectVersion` ← `project.version`
- 客户端：`clientVersion` ← `client.clientVersion`

`409 version_conflict` → 重新 GET，更新版本号后重试。

---

## 回复模板

```markdown
## 已完成

**操作**：[创建项目 / 注册客户端 / 修改配置 / …]

**项目**：[name] (`[projectId]`)
**客户端**：[displayName] (`[clientId]`)（如适用）

**配置摘要**

- 类型：[web / spa]
- Redirect URI：[…]
- Scope：[…]

**Client Secret**（如有，仅显示一次）
```

<secret>
```

请立即保存，之后无法再次获取。

**后续步骤**

1. …

```

---

## 意图 → API

| 用户说 | 调用 |
| --- | --- |
| 创建项目 MyApp | `POST /projects` `{ "name": "MyApp" }` |
| 注册 SPA，回调 https://app/cb | `POST .../clients` + `clientType:"spa"` + `redirectUris` |
| 改 redirect URI | `GET client` → `PUT .../revision` |
| 加 maintainer | `POST .../members` + `role` + `expectedProjectVersion` |
| 轮换 secret | `GET client` → `POST .../secrets/rotate` |

权限继承项目角色：owner / maintainer / viewer。
```
