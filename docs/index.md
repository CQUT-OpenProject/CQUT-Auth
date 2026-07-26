---
layout: home

hero:
  name: CQUT Auth
  text: 校园 OIDC Provider
  tagline: 通过重庆理工大学 UIS / CAS 验证学校账号，向受控客户端签发 OpenID Connect 令牌。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: OIDC 接入
      link: /oidc/overview
    - theme: alt
      text: GitHub
      link: https://github.com/CQUT-OpenProject/CQUT-Auth

features:
  - title: Authorization Code + PKCE
    details: 强制 PKCE S256，支持 Web 与 SPA 客户端；不开放 Implicit 与动态注册。
  - title: 学校账号登录
    details: 服务端完成 UIS / CAS 校验，将学校身份关联到本地 Subject。
  - title: 客户端管理后台
    details: 项目成员、Revision 审核、Secret 轮换、运行策略与邮件通道均可在 /manage 配置。
  - title: 生产就绪基线
    details: PostgreSQL 持久化、Redis 限流 fail-closed、签名密钥加密存储与审计记录。
---
