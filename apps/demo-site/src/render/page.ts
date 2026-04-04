import type { DemoClientState } from "../client/types.js";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serializeState(state: DemoClientState) {
  return encodeURIComponent(JSON.stringify(state));
}

export function renderAppShell(title: string, state: DemoClientState) {
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>${safeTitle}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/demo/assets/app.css">
      <script type="module" src="/demo/assets/app.js"></script>
    </head>
    <body>
      <div id="root" data-state="${escapeHtml(serializeState(state))}"></div>
    </body>
  </html>`;
}

export function renderMessagePage(title: string, message: string, detail?: string) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeDetail = detail ? escapeHtml(detail) : "";
  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>${safeTitle}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        :root {
          color-scheme: light;
          --bg: #d3d3d3;
          --panel: #f5f5f5;
          --line: #111;
          --shadow-light: #fff;
          --shadow-dark: #8e8e8e;
        }
        * { box-sizing: border-box; }
        html, body { min-height: 100%; margin: 0; }
        body {
          display: grid;
          place-items: center;
          padding: 16px;
          background:
            repeating-linear-gradient(0deg, rgba(255,255,255,.12) 0, rgba(255,255,255,.12) 1px, rgba(0,0,0,.03) 1px, rgba(0,0,0,.03) 2px),
            linear-gradient(180deg, #dbdbdb 0%, var(--bg) 100%);
          color: #111;
          font-family: "Chicago", "Geneva", "Helvetica Neue", Arial, sans-serif;
        }
        .dialog {
          width: min(720px, 100%);
          border: 2px solid var(--line);
          background: var(--panel);
          box-shadow: 0 0 0 2px var(--shadow-light), 10px 10px 0 rgba(0,0,0,.14);
        }
        .head {
          padding: 8px 12px;
          border-bottom: 2px solid var(--line);
          background: repeating-linear-gradient(180deg, #fff 0, #fff 4px, #bebebe 4px, #bebebe 8px);
          text-align: center;
          text-transform: uppercase;
          letter-spacing: .08em;
        }
        .body { padding: 18px; }
        h1 { margin: 0 0 12px; font-size: 1.25rem; }
        p { margin: 0 0 16px; line-height: 1.5; }
        pre {
          margin: 0 0 16px;
          padding: 12px;
          overflow: auto;
          border: 2px solid var(--line);
          background: #fff;
          font-family: "Monaco", "Courier New", monospace;
        }
        a {
          display: inline-block;
          padding: 9px 14px;
          border: 2px solid var(--line);
          background: linear-gradient(180deg, #fff 0%, #dadada 100%);
          box-shadow: inset 2px 2px 0 var(--shadow-light), inset -2px -2px 0 var(--shadow-dark);
          color: inherit;
          text-decoration: none;
        }
      </style>
    </head>
    <body>
      <main class="dialog">
        <div class="head">${safeTitle}</div>
        <div class="body">
          <h1>${safeTitle}</h1>
          <p>${safeMessage}</p>
          ${detail ? `<pre>${safeDetail}</pre>` : ""}
          <a href="/demo">Back to Demo</a>
        </div>
      </main>
    </body>
  </html>`;
}
