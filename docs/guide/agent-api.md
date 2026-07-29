# Agent API（AI 接入）

Agent API 为 AI 助手和自动化脚本提供 REST 入口，用于管理 OIDC 项目、客户端与成员。用户只需提供重庆理工大学账号密码，并与 AI 对齐需求，即可完成客户端注册与配置修改。

## 启用

Agent API 通过环境变量控制：

| 变量                     | 说明                  | 默认值                              |
| ------------------------ | --------------------- | ----------------------------------- |
| `OIDC_AGENT_API_ENABLED` | 是否挂载 `/api/agent` | 非生产环境 `true`，生产环境 `false` |

生产环境如需启用，显式设置 `OIDC_AGENT_API_ENABLED=true`。

## 发现规范

AI 接入时建议按以下顺序自发现：

1. **`GET /api/agent/instructions`** — 返回系统提示词与操作指南（Markdown，无需认证）
2. **`GET /api/agent/openapi.json`** — OpenAPI 3.1 规范，描述端点与请求格式

`instructions` 响应示例：

```json
{
  "version": "1.0.0",
  "baseUrl": "https://auth.example.com/api/agent",
  "openapiUrl": "https://auth.example.com/api/agent/openapi.json",
  "contentType": "text/markdown",
  "prompt": "你是 CQUT Auth 客户端管理助手..."
}
```

OpenAPI 的 `info.x-agent-instructions` 字段指向 `/instructions`。仓库内源文件见 [`openapi/agent-instructions.md`](https://github.com/CQUT-OpenProject/CQUT-Auth/blob/master/openapi/agent-instructions.md) 与 [`openapi/agent.json`](https://github.com/CQUT-OpenProject/CQUT-Auth/blob/master/openapi/agent.json)。

用户只需告诉 AI 服务地址（如 `https://auth.example.com/api/agent`），Agent 即可自行拉取提示词与规范。

## 认证流程

1. **登录** — `POST /api/agent/auth/login`

```json
{ "account": "your-student-id", "password": "your-password" }
```

响应：

```json
{
  "accessToken": "...",
  "tokenType": "Bearer",
  "expiresIn": 86400,
  "user": {
    "subjectId": "subj_...",
    "displayName": "...",
    "isAdmin": false
  },
  "clientSecretPolicy": {
    "defaultGraceSeconds": 3600,
    "maxGraceSeconds": 604800
  }
}
```

2. **后续请求** — 在 Header 中携带：

```
Authorization: Bearer <accessToken>
```

3. **会话结束** — `POST /api/agent/auth/logout`（建议 AI 完成任务后调用）

Agent API **不需要** CSRF Token，与管理后台 `/api/management` 的 Cookie 模式不同。

## 能力范围

| 类别   | 操作                                         |
| ------ | -------------------------------------------- |
| 项目   | 列表、详情、创建、编辑（含归档）             |
| 成员   | 列表、添加、修改角色、移除、转移所有权       |
| 客户端 | 列表、详情、注册、修改元数据、修改 OIDC 配置 |
| 凭据   | Web 客户端 Secret 轮换                       |

权限与管理后台一致，继承当前用户在项目中的角色（owner / maintainer / viewer）。

## 典型对话 → API 映射

| 用户说                                                                 | AI 应执行的调用                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 「帮我创建一个名叫 MyApp 的项目」                                      | `POST /projects` `{ "name": "MyApp" }`                                                      |
| 「在这个项目里注册一个 SPA 客户端，回调地址是 https://app.example/cb」 | `POST /projects/:id/clients` 含 `clientType: "spa"`、`redirectUris`                         |
| 「把 redirect URI 改成 https://new.example/cb」                        | `GET .../clients/:id` 取 `clientVersion` → `PUT .../revision`                               |
| 「给张三加 maintainer 权限」                                           | `POST .../members` `{ "subjectId": "...", "role": "maintainer", "expectedProjectVersion" }` |
| 「轮换这个客户端的 secret」                                            | `GET client` → `POST .../secrets/rotate` `{ "clientVersion" }`                              |

## 客户端注册字段

创建客户端（`POST /projects/:projectId/clients`）：

| 字段                     | 必填 | 说明                                      |
| ------------------------ | ---- | ----------------------------------------- |
| `clientType`             | 是   | `web`（机密客户端）或 `spa`（公开客户端） |
| `displayName`            | 是   | 显示名称                                  |
| `description`            | 否   | 描述                                      |
| `redirectUris`           | 是   | 至少一个回调 URI                          |
| `postLogoutRedirectUris` | 否   | 登出回调 URI                              |
| `scopeWhitelist`         | 是   | 权限范围，须包含 `openid`                 |
| `requirePkce`            | 否   | Web 客户端可选；SPA 强制为 `true`         |

可用 Scope：`openid`、`profile`、`email`、`student`、`offline_access`。SPA 客户端不可申请 `offline_access`。

## 版本冲突处理

变更项目或客户端时需携带乐观锁版本号：

- 项目：`expectedProjectVersion`（来自 `project.version`）
- 客户端：`clientVersion`（来自 `client.clientVersion`）

若返回 `409 version_conflict`，先 `GET` 最新资源，更新版本号后重试。

## 一次性 Client Secret

Web 客户端在**创建**和**轮换 Secret** 时，响应中会包含明文 `clientSecret`（或 `secret.value`）。此值**仅返回一次**，AI 必须立即告知用户保存。之后无法再次获取。

## 安全提示

- 账号密码会经 AI 对话中转，请仅在可信环境使用
- 建议在任务完成后调用 `POST /auth/logout` 吊销 Token
- 生产环境默认关闭 Agent API，部署者需显式启用并评估风险
- Agent Token 与管理后台 Session 共用存储，同一账号可同时存在多个有效 Token

## 与管理 API 的区别

|           | `/api/management` | `/api/agent`    |
| --------- | ----------------- | --------------- |
| 用途      | 浏览器管理后台    | AI / 脚本       |
| 认证      | HttpOnly Cookie   | Bearer Token    |
| CSRF      | 必需              | 不需要          |
| 登录 CSRF | 必需              | 不需要          |
| 业务逻辑  | 相同 Service 层   | 相同 Service 层 |
