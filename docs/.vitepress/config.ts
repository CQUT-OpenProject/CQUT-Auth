import { defineConfig } from "vitepress";

const base = process.env.DOCS_BASE || "/";

export default defineConfig({
  title: "CQUT Auth",
  description: "重庆理工大学 OIDC Provider 文档",
  lang: "zh-CN",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: `${base}logo.svg`, type: "image/svg+xml" }],
  ],
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "指南", link: "/guide/introduction" },
      { text: "OIDC 接入", link: "/oidc/overview" },
      { text: "部署", link: "/deploy/production" },
      {
        text: "仓库",
        link: "https://github.com/CQUT-OpenProject/CQUT-Auth",
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "指南",
          items: [
            { text: "项目介绍", link: "/guide/introduction" },
            { text: "本地启动", link: "/guide/getting-started" },
            { text: "开发", link: "/guide/development" },
            { text: "安全说明", link: "/guide/security" },
          ],
        },
      ],
      "/oidc/": [
        {
          text: "OIDC 接入",
          items: [
            { text: "端点与流程", link: "/oidc/overview" },
            { text: "Scope 与 Claim", link: "/oidc/scopes" },
            { text: "客户端生命周期", link: "/oidc/client-lifecycle" },
          ],
        },
      ],
      "/deploy/": [
        {
          text: "部署",
          items: [
            { text: "生产部署", link: "/deploy/production" },
            { text: "配置说明", link: "/deploy/configuration" },
            { text: "UIS / CAS", link: "/deploy/uis-cas" },
          ],
        },
      ],
    },
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/CQUT-OpenProject/CQUT-Auth",
      },
    ],
    search: {
      provider: "local",
    },
    editLink: {
      pattern:
        "https://github.com/CQUT-OpenProject/CQUT-Auth/edit/master/docs/:path",
      text: "在 GitHub 上编辑此页",
    },
    footer: {
      message: "基于 MIT 协议开源",
      copyright: "Copyright © CQUT OpenProject",
    },
    outline: {
      label: "本页目录",
    },
    docFooter: {
      prev: "上一页",
      next: "下一页",
    },
    lastUpdated: {
      text: "最后更新",
    },
  },
});
