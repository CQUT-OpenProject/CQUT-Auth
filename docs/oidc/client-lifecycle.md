# 客户端生命周期

客户端由项目成员在 `/manage` 创建：

1. 创建项目并维护 owner、maintainer、viewer 成员；
2. 创建 Web 或 SPA 客户端；
3. 编辑 Redirect URI、Logout URI 和 Scope；
4. 提交 Revision；
5. 等待管理员批准后进入可用状态。

## 配置变更

修改已启用客户端的安全相关配置时，系统会生成新的 Revision；审核期间，客户端继续使用上一份已批准的配置。

## Secret 管理

- Web Client Secret 只在创建或轮换响应中显示一次。
- 数据库仅保存 scrypt 摘要。
- 支持宽限期轮换和指定撤销。

## 停用与撤销

停用客户端或撤销授权后，对应的 Artifact 会立即失效。
