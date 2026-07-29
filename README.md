![仓库封面](./.github/assets/repository-cover.svg)

<div align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24+-green.svg?style=flat" alt="Node.js 24+"></a>
  <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/pnpm-10+-orange.svg?style=flat" alt="pnpm 10+"></a>
  <a href="https://cqut-openproject.github.io/CQUT-Auth/"><img src="https://img.shields.io/badge/Docs-VitePress-646cff.svg?style=flat" alt="Docs"></a>
</div>

> [!NOTE]
> CQUT Auth 是为受控客户端提供登录服务的 OpenID Connect Provider。它通过重庆理工大学 UIS / CAS 验证学校账号，将验证结果关联到本地 Subject，再通过 Authorization Code + PKCE 向已审核的客户端签发令牌。
>
> 项目还提供客户端管理后台，可管理项目成员和 OIDC 客户端，配置 Redirect URI、Scope 与 Client Secret，并处理审核和运行策略。
>
> **完整文档**：[GitHub Pages 文档站](https://cqut-openproject.github.io/CQUT-Auth/)

> [!CAUTION]
> 本项目会在登录期间接收学校账号和密码，并将其用于请求 UIS；凭据不会写入数据库。部署者仍需自行完成安全评审、日志审计、网络隔离、密钥管理和隐私合规。请勿将未经审计的实例直接用于生产环境。

## 能力与边界

- OIDC Authorization Code + 强制 PKCE；支持 Web 与 SPA 客户端
- Scope：`openid`、`profile`、`email`、`student`、`offline_access`
- UIS / CAS 登录与学校身份关联；PostgreSQL 持久化；Redis 限流（生产 fail-closed）
- 客户端 Revision 审核、项目成员权限、Secret 轮换、邮箱验证与运行策略

## 快速体验

本地功能测试（非生产配置）：

```bash
pnpm install
pnpm init-env --profile test
pnpm docker:up
```

管理后台：`http://127.0.0.1:3003/manage`  
更多步骤与说明见 [本地启动](https://cqut-openproject.github.io/CQUT-Auth/guide/getting-started)。

## 文档

| 章节      | 链接                                                                           |
| --------- | ------------------------------------------------------------------------------ |
| 项目介绍  | [指南](https://cqut-openproject.github.io/CQUT-Auth/guide/introduction)        |
| 本地启动  | [快速开始](https://cqut-openproject.github.io/CQUT-Auth/guide/getting-started) |
| OIDC 接入 | [端点与流程](https://cqut-openproject.github.io/CQUT-Auth/oidc/overview)       |
| 生产部署  | [部署](https://cqut-openproject.github.io/CQUT-Auth/deploy/production)         |
| 配置说明  | [环境变量](https://cqut-openproject.github.io/CQUT-Auth/deploy/configuration)  |
| 开发      | [开发指南](https://cqut-openproject.github.io/CQUT-Auth/guide/development)     |
| 安全      | [安全说明](https://cqut-openproject.github.io/CQUT-Auth/guide/security)        |

## 切换到旧版

旧版系统位于 `legacy` 分支，不包含客户端管理功能，目前已停止维护。

## 特别感谢

「[CQUT校园网登录脚本](https://github.com/coldriver-chen/cqut-net-login)」公开的重要信息，作为本项目的基座。本项目在其基础上进行了进一步的逆向分析与改进。

## 许可证

本项目基于 [MIT](./LICENSE) 协议开源。
