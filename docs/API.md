# API

本文档描述当前仓库中已经实现并对外暴露的接口，分为两层：

- `auth-service`：核心验证服务
- `demo-site`：示例站点代理层

## Overview

当前主流程是查询式验证：

1. 业务服务端通过 Basic Auth 向 `auth-service` 发起 `POST /verify`
2. 服务端得到 `request_id`
3. 业务服务端通过 Basic Auth 轮询 `GET /result/:requestId`
4. demo-site 以网页方式演示这条服务端链路

## auth-service

基础信息：

- 默认地址：`http://localhost:3001`
- 生产反代后：`http://verify.local/api`
- 生产 HTTPS 域名建议：`https://auth.xxx.com/api`

### `POST /verify`

发起新的学生身份验证任务。

请求头：

```http
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/json
Accept: application/json
```

请求体：

```json
{
  "account": "12XXXXXXXXX",
  "password": "******",
  "scope": ["student.verify", "student.dedupe"]
}
```

字段说明：

- `account`：校园账号
- `password`：校园密码
- `scope`：可选；若不传则默认退回 `["student.verify"]`

当前支持 scope：

- `student.verify`
- `student.dedupe`

成功响应：

```json
{
  "request_id": "req_xxx",
  "status": "pending",
  "expires_at": "2026-04-02T12:00:00.000Z"
}
```

状态码：

- `202`：任务已入队
- `400`：请求参数错误
- `401` / `403`：客户端认证失败或验证失败
- `429`：命中限流

错误响应示例：

```json
{
  "error": "invalid_client",
  "error_description": "client authentication failed"
}
```

### `GET /result/:requestId`

按请求 ID 查询验证结果。

请求：

```http
GET /result/req_xxx
Authorization: Basic base64(client_id:client_secret)
Accept: application/json
```

#### `pending` / `running`

```json
{
  "request_id": "req_xxx",
  "status": "pending",
  "expires_at": "2026-04-02T12:00:00.000Z"
}
```

或：

```json
{
  "request_id": "req_xxx",
  "status": "running",
  "expires_at": "2026-04-02T12:00:00.000Z"
}
```

#### `succeeded`

```json
{
  "request_id": "req_xxx",
  "status": "succeeded",
  "verified": true,
  "student_status": "active_student",
  "school": "cqut",
  "dedupe_key": "ddk_xxx",
  "completed_at": "2026-04-02T12:00:03.000Z"
}
```

说明：

- `dedupe_key` 只有在请求 scope 包含 `student.dedupe` 且验证成功时才会返回

#### `failed`

```json
{
  "request_id": "req_xxx",
  "status": "failed",
  "error": "verification_failed",
  "error_description": "campus credentials rejected",
  "completed_at": "2026-04-02T12:00:03.000Z"
}
```

#### 常见错误

```json
{
  "error": "rate_limited",
  "error_description": "verification rate limit exceeded",
  "retry_after_seconds": 52
}
```

当命中限流时：

- 状态码为 `429`
- 响应头会带 `Retry-After`
- 响应体可能带 `retry_after_seconds`

### `GET /health/live`

存活探针。

### `GET /health/ready`

返回服务健康状态及当前运行模式。

成功响应：

```json
{
  "status": "ready",
  "env": "development",
  "worker_mode": "inline",
  "provider": "mock",
  "database": "memory",
  "redis": "optional"
}
```

字段说明：

- `env`：来自 `APP_ENV`
- `worker_mode`：当前 worker 运行模式，`inline` 或 `external`
- `provider`：当前 provider，通常是 `mock` 或 `cqut`
- `database`：`postgres`、`memory` 或 `unavailable`
- `redis`：`ready`、`optional` 或 `unavailable`

返回语义：

- 依赖满足时返回 `200`
- 依赖未满足时返回 `503`

## demo-site

基础信息：

- 默认地址：`http://localhost:3002`
- 生产反代后：`http://verify.local/demo`

demo-site 是服务端代理层，不是纯静态页面。浏览器端不直接发送 `client_id` / `client_secret`。

### `GET /demo`

返回示例页面壳与前端构建产物：

- `/demo`
- `/demo/assets/app.js`
- `/demo/assets/style.css`

### `POST /demo/api/verify`

浏览器提交账号密码给 demo-site，由 demo-site 再转发到 auth-service。

请求体：

```json
{
  "account": "12XXXXXXXXX",
  "password": "******"
}
```

demo-site 会在服务端使用自己的配置生成 Basic Auth，并补充默认 scope：

- `Authorization: Basic base64(DEMO_CLIENT_ID:DEMO_CLIENT_SECRET)`
- `scope: ["student.verify"]`

成功响应与 auth-service 的 `POST /verify` 一致。

错误特性：

- 会透传 auth-service 的状态码与 JSON body
- 会保留 `Retry-After`
- 额外加 `Cache-Control: no-store`

### `GET /demo/api/result/:requestId`

浏览器通过 demo-site 轮询结果，demo-site 服务端再携带 demo client 凭据向 auth-service 查询。

成功响应与 auth-service 的 `GET /result/:requestId` 一致。

## curl 示例

### 直接调用 auth-service

发起验证：

```bash
curl -X POST http://verify.local/api/verify \
  -u 'site_demo:dev-secret-change-me' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{
    "account": "20240001",
    "password": "your-password",
    "scope": ["student.verify"]
  }'
```

轮询结果：

```bash
curl http://localhost:3001/result/req_xxx \
  -u 'site_demo:dev-secret-change-me' \
  -H 'Accept: application/json'
```

### 调用 demo-site 代理层

发起验证：

```bash
curl -X POST http://localhost:3002/demo/api/verify \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{
    "account": "12XXXXXXXXX",
    "password": "your-password"
  }'
```

轮询结果:

```bash
curl "http://localhost:3002/demo/api/result/req_xxx"
```

## Errors

当前错误对象统一为：

```json
{
  "error": "invalid_request",
  "error_description": "..."
}
```

当前代码中可见的常用错误码包括：

- `invalid_request`
- `invalid_client`
- `invalid_scope`
- `rate_limited`
- `verification_failed`
- `server_error`
- `upstream_unavailable`（demo-site 代理层自有）
