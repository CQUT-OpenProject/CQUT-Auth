import { escapeHtml } from "../utils.js";

export function renderBrandedPage(title: string, body: string, styles = "") {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(title)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      <style>${styles}</style>
    </head>
    <body>
      <header class="page-header">
        <img class="brand-logo brand-logo-light" src="/logo-auth-color.svg" alt="CQUT Auth 统一身份认证服务">
        <img class="brand-logo brand-logo-dark" src="/logo-auth-mono-light.svg" alt="CQUT Auth 统一身份认证服务">
      </header>
      <div class="page-shell"><main class="container">${body}</main></div>
    </body>
  </html>`;
}
