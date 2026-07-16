import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  IdentityCoreError,
  RetryableProviderError,
} from "../identity/errors.js";
import { hasSafeCredentialLengths } from "../identity/types.js";
import express, { type Request, type Response } from "express";
import type { OidcOpConfig } from "../config.js";
import {
  RateLimitUnavailableError,
  type RateLimitDecision,
  type RateLimitService,
} from "../persistence/rate-limit.service.js";
import type {
  OidcPersistence,
  PendingInteractionLogin,
} from "../persistence/contracts.js";
import type { OidcServices } from "../oidc/provider.js";
import { resolveTrustedExpressRequestIp } from "../request-ip.js";
import {
  base64Url,
  escapeHtml,
  isValidEmail,
  parseCookies,
  randomId,
  sha256,
  sha256Base64Url,
} from "../utils.js";

function setNoStore(response: Response) {
  response.setHeader("Cache-Control", "no-store");
}

type CsrfFlow = "login" | "profile" | "consent";
const CSRF_NONCE_COOKIE_NAME = "op_csrf_nonce";

type CsrfTokenPayload = {
  uid: string;
  flow: CsrfFlow;
  iat: number;
  exp: number;
  nonce_hash: string;
};

function setCsrfNonceCookie(
  response: Response,
  config: OidcOpConfig,
  nonce: string,
) {
  response.cookie(CSRF_NONCE_COOKIE_NAME, nonce, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
  });
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function secureStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function signCsrfPayload(payloadBase64Url: string, secret: string): string {
  return base64Url(
    createHmac("sha256", secret).update(payloadBase64Url).digest(),
  );
}

function issueCsrfToken(
  response: Response,
  config: OidcOpConfig,
  uid: string,
  flow: CsrfFlow,
): string {
  const nonce = randomId("csrfn");
  setCsrfNonceCookie(response, config, nonce);
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: CsrfTokenPayload = {
    uid,
    flow,
    iat: issuedAt,
    exp: issuedAt + config.csrfTokenTtlSeconds,
    nonce_hash: sha256Base64Url(nonce),
  };
  const payloadBase64Url = base64Url(
    Buffer.from(JSON.stringify(payload), "utf8"),
  );
  const signature = signCsrfPayload(payloadBase64Url, config.csrfSigningSecret);
  return `${payloadBase64Url}.${signature}`;
}

function parseAndValidateCsrfPayload(
  token: string,
  secret: string,
): CsrfTokenPayload | null {
  const segments = token.split(".");
  if (segments.length !== 2) {
    return null;
  }
  const [payloadBase64Url, signature] = segments;
  if (!payloadBase64Url || !signature) {
    return null;
  }
  const expectedSignature = signCsrfPayload(payloadBase64Url, secret);
  if (!secureStringEqual(signature, expectedSignature)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      decodeBase64Url(payloadBase64Url).toString("utf8"),
    ) as Partial<CsrfTokenPayload>;
    if (
      typeof parsed.uid !== "string" ||
      (parsed.flow !== "login" &&
        parsed.flow !== "profile" &&
        parsed.flow !== "consent") ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      typeof parsed.nonce_hash !== "string"
    ) {
      return null;
    }
    return parsed as CsrfTokenPayload;
  } catch {
    return null;
  }
}

function validateCsrf(
  request: Request,
  config: OidcOpConfig,
  expected: { uid: string; flow: CsrfFlow; token: string | undefined },
): boolean {
  if (!expected.token) {
    return false;
  }
  const payload = parseAndValidateCsrfPayload(
    expected.token,
    config.csrfSigningSecret,
  );
  if (!payload) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now || payload.iat > now + 5) {
    return false;
  }
  if (payload.uid !== expected.uid || payload.flow !== expected.flow) {
    return false;
  }
  const cookies = parseCookies(request.headers.cookie);
  const nonce = cookies[CSRF_NONCE_COOKIE_NAME];
  if (!nonce) {
    return false;
  }
  return secureStringEqual(payload.nonce_hash, sha256Base64Url(nonce));
}

function getScriptNonce(response: Response) {
  const nonce = response.locals["cspScriptNonce"];
  return typeof nonce === "string" ? nonce : "";
}

function renderInteractionPageStyles(): string {
  return `
        :root {
          --ink: #0e2233;
          --ink-soft: #52667a;
          --paper: #eef3f8;
          --card: #fdfefe;
          --line: #d3dfe9;
          --line-strong: #a9bfd2;
          --brand: #0b1f33;
          --brand-2: #055088;
          --accent: #2eaf72;
          --danger: #a43e2e;
          --danger-bg: #faeee9;
          --ok: #1e7a53;
          --ok-bg: #eaf5ec;
          --info: #0b4a72;
          --info-bg: #ecf3f2;
          --focus-ring: rgba(5, 80, 136, 0.22);
          --serif: "Source Han Serif SC", "Noto Serif SC", "Songti SC", STSong, Georgia, "Times New Roman", serif;
          --sans: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
        }
        * { box-sizing: border-box; }
        body {
          font-family: var(--sans);
          margin: 0;
          padding: 2rem 1.25rem;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          color: var(--ink);
          background-color: var(--paper);
          background-image:
            repeating-radial-gradient(circle at 50% -60vh, transparent 0, transparent 38px, rgba(5, 80, 136, 0.035) 39px, transparent 40px),
            repeating-linear-gradient(45deg, transparent 0, transparent 11px, rgba(5, 80, 136, 0.02) 11px, rgba(5, 80, 136, 0.02) 12px),
            repeating-linear-gradient(-45deg, transparent 0, transparent 11px, rgba(5, 80, 136, 0.02) 11px, rgba(5, 80, 136, 0.02) 12px),
            radial-gradient(120% 90% at 50% 0%, rgba(5, 80, 136, 0.06), transparent 60%);
        }
        .container {
          width: 100%;
          max-width: 27rem;
          background: var(--card);
          border: 1px solid var(--line-strong);
          border-radius: 3px;
          box-shadow:
            0 0 0 4px var(--card),
            0 0 0 5px var(--line),
            0 24px 48px -24px rgba(11, 31, 51, 0.35);
          padding: 2.25rem 2.25rem 2rem;
          position: relative;
          animation: card-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .container::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 4px;
          background: repeating-linear-gradient(
            -55deg,
            var(--brand-2) 0,
            var(--brand-2) 7px,
            var(--accent) 7px,
            var(--accent) 9px
          );
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 0.85rem;
          margin-bottom: 1.6rem;
          animation: rise-in 0.55s 0.08s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .brand-mark {
          width: 2.6rem;
          height: 2.6rem;
          flex: none;
          color: var(--brand-2);
        }
        .brand-name {
          font-family: var(--serif);
          font-weight: 700;
          font-size: 1.18rem;
          letter-spacing: 0.02em;
          color: var(--brand);
          line-height: 1.2;
        }
        .brand-sub {
          font-size: 0.68rem;
          letter-spacing: 0.32em;
          color: var(--ink-soft);
          margin-top: 0.2rem;
        }
        .rule {
          border: none;
          height: 1px;
          margin: 0 0 1.5rem;
          background: linear-gradient(to right, transparent, var(--line-strong) 18%, var(--line-strong) 82%, transparent);
          position: relative;
          overflow: visible;
        }
        .rule::after {
          content: "";
          position: absolute;
          left: 50%;
          top: -3px;
          width: 7px;
          height: 7px;
          transform: translateX(-50%) rotate(45deg);
          background: var(--card);
          border: 1px solid var(--line-strong);
        }
        main {
          animation: rise-in 0.55s 0.16s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        h1 {
          font-family: var(--serif);
          font-size: 1.5rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          margin: 0 0 0.5rem;
          text-align: center;
          color: var(--brand);
        }
        .hint {
          color: var(--ink-soft);
          font-size: 0.92rem;
          line-height: 1.6;
          text-align: center;
          margin: 0 0 1.6rem;
        }
        .hint strong { color: var(--ink); }
        form {
          display: grid;
          gap: 0.9rem;
        }
        form + form { margin-top: 0.9rem; }
        input {
          padding: 0.78rem 0.9rem;
          font-size: 1rem;
          font-family: var(--sans);
          background-color: rgba(255, 255, 255, 0.65);
          border: 1px solid var(--line-strong);
          border-radius: 2px;
          color: var(--ink);
          outline: none;
          transition: border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
          width: 100%;
        }
        input::placeholder { color: #8aa2b6; }
        input:focus {
          border-color: var(--brand-2);
          background-color: #ffffff;
          box-shadow: 0 0 0 3px var(--focus-ring);
        }
        input[readonly] {
          background-color: var(--paper);
          color: var(--ink-soft);
          cursor: not-allowed;
        }
        button {
          padding: 0.82rem 1.25rem;
          font-size: 0.98rem;
          font-weight: 600;
          font-family: var(--sans);
          letter-spacing: 0.14em;
          background-color: var(--brand-2);
          color: #f2f7fb;
          border: 1px solid var(--brand-2);
          border-radius: 2px;
          cursor: pointer;
          position: relative;
          transition: background-color 0.18s ease, border-color 0.18s ease, transform 0.1s ease, box-shadow 0.18s ease;
        }
        button:hover {
          background-color: #0a66a8;
          border-color: #0a66a8;
          box-shadow: 0 6px 16px -8px rgba(5, 80, 136, 0.55);
        }
        button:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px var(--focus-ring);
        }
        button:active { transform: translateY(1px); }
        button[disabled] {
          cursor: wait;
          opacity: 0.6;
          pointer-events: none;
        }
        .secondary {
          background-color: transparent;
          border: 1px solid var(--line-strong);
          color: var(--ink-soft);
        }
        .secondary:hover {
          background-color: rgba(11, 31, 51, 0.05);
          border-color: var(--ink-soft);
          box-shadow: none;
        }
        .error, .success, .pending {
          padding: 0.75rem 0.9rem;
          border-radius: 2px;
          font-size: 0.88rem;
          line-height: 1.55;
          margin: 0 0 1rem;
        }
        form .error, form .success, form .pending { margin-bottom: 0; }
        .error {
          color: var(--danger);
          background-color: var(--danger-bg);
          border: 1px solid currentColor;
          border-left-width: 3px;
        }
        .success {
          color: var(--ok);
          background-color: var(--ok-bg);
          border: 1px solid currentColor;
          border-left-width: 3px;
        }
        .pending {
          display: none;
          color: var(--info);
          background-color: var(--info-bg);
          border: 1px solid currentColor;
          border-left-width: 3px;
        }
        .pending strong {
          display: block;
          margin-bottom: 0.2rem;
          font-weight: 600;
        }
        .login-form[data-submitting="true"] .pending { display: block; }
        .button-loading { display: none; }
        .login-form[data-submitting="true"] .button-label { display: none; }
        .login-form[data-submitting="true"] .button-loading { display: inline; }
        p { line-height: 1.6; }
        p strong { color: var(--brand); }
        ul {
          padding-left: 1.25rem;
          margin: 0 0 1rem;
          color: var(--ink-soft);
          line-height: 1.6;
        }
        li { margin-bottom: 0.4rem; }
        .page-foot {
          margin-top: 1.4rem;
          font-size: 0.72rem;
          letter-spacing: 0.18em;
          color: var(--ink-soft);
          text-align: center;
          animation: rise-in 0.55s 0.26s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes card-in {
          from { opacity: 0; transform: translateY(14px) scale(0.99); }
          to { opacity: 1; transform: none; }
        }
        @keyframes rise-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .container, .brand, main, .page-foot { animation: none; }
        }
        @media (max-width: 480px) {
          .container { padding: 1.8rem 1.4rem 1.6rem; }
        }

        @media (prefers-color-scheme: dark) {
          :root {
            --ink: #e6e9e4;
            --ink-soft: #97a5ae;
            --paper: #081420;
            --card: #0e2033;
            --line: #1d3348;
            --line-strong: #2c4a63;
            --brand: #d7e5ef;
            --brand-2: #3c9ae8;
            --accent: #48c98a;
            --danger: #e8917f;
            --danger-bg: rgba(164, 62, 46, 0.16);
            --ok: #6fce9f;
            --ok-bg: rgba(30, 122, 83, 0.16);
            --info: #7cc0e8;
            --info-bg: rgba(11, 74, 114, 0.2);
            --focus-ring: rgba(23, 125, 220, 0.35);
          }
          body {
            background-image:
              repeating-radial-gradient(circle at 50% -60vh, transparent 0, transparent 38px, rgba(126, 168, 199, 0.05) 39px, transparent 40px),
              repeating-linear-gradient(45deg, transparent 0, transparent 11px, rgba(126, 168, 199, 0.03) 11px, rgba(126, 168, 199, 0.03) 12px),
              repeating-linear-gradient(-45deg, transparent 0, transparent 11px, rgba(126, 168, 199, 0.03) 11px, rgba(126, 168, 199, 0.03) 12px),
              radial-gradient(120% 90% at 50% 0%, rgba(23, 125, 220, 0.1), transparent 60%);
          }
          .container {
            box-shadow:
              0 0 0 4px var(--card),
              0 0 0 5px var(--line),
              0 28px 56px -24px rgba(0, 0, 0, 0.6);
          }
          .container::before {
            background: repeating-linear-gradient(
              -55deg,
              var(--brand-2) 0,
              var(--brand-2) 7px,
              var(--accent) 7px,
              var(--accent) 9px
            );
          }
          .rule::after { background: var(--card); border-color: var(--line-strong); }
          input {
            background-color: rgba(8, 20, 32, 0.55);
          }
          input::placeholder { color: #5c7185; }
          input:focus { background-color: #0a1a2a; }
          input[readonly] { background-color: #0a1a2a; }
          button {
            background-color: #177ddc;
            border-color: #177ddc;
            color: #f2f7fb;
          }
          button:hover {
            background-color: #3c9ae8;
            border-color: #3c9ae8;
            box-shadow: 0 6px 18px -8px rgba(23, 125, 220, 0.5);
          }
          button[disabled] {
            background-color: #1d3348;
            border-color: #1d3348;
            color: #5c7185;
          }
          .secondary {
            background-color: transparent;
            border-color: var(--line-strong);
            color: var(--ink-soft);
          }
          .secondary:hover {
            background-color: rgba(126, 168, 199, 0.08);
            border-color: var(--ink-soft);
          }
        }

        /* CQUT-OSP design-system overrides. */
        :root {
          color-scheme: light dark;
          --ink: #0b1f33;
          --ink-soft: #526577;
          --paper: #f7fafc;
          --card: #ffffff;
          --line: #d7e2ea;
          --line-strong: #92a8b8;
          --brand-2: #055088;
          --accent: #6adfa3;
          --danger: #a43e2e;
          --danger-bg: #faeee9;
          --ok: #1e7a53;
          --ok-bg: #eaf5ec;
          --info: #0b4a72;
          --info-bg: #ecf3f2;
        }
        html { min-width: 320px; }
        body {
          padding: 0;
          align-items: stretch;
          justify-content: flex-start;
          background: var(--paper);
          background-image: none;
        }
        .page-header { padding: 24px; }
        .brand-logo {
          display: block;
          width: min(256px, 100%);
          height: auto;
        }
        .brand-logo-dark { display: none; }
        .page-shell {
          flex: 1;
          display: grid;
          place-items: center;
          padding: 32px 16px 64px;
        }
        .container {
          max-width: 400px;
          padding: 32px;
          border: 1px solid var(--line);
          border-radius: 12px;
          box-shadow: none;
          animation: none;
        }
        .container::before { display: none; }
        main { animation: none; }
        h1 {
          margin: 0 0 8px;
          font-family: var(--sans);
          font-size: 1.75rem;
          font-weight: 800;
          line-height: 1.25;
          letter-spacing: 0;
          text-align: left;
        }
        .hint {
          margin: 0 0 24px;
          font-size: 0.9375rem;
          line-height: 1.65;
          text-align: left;
        }
        .independence-note {
          margin: 24px 0 0;
          padding-top: 16px;
          border-top: 1px solid var(--line);
          color: var(--ink-soft);
          font-size: 0.8125rem;
          line-height: 1.65;
        }
        form { gap: 16px; }
        form + form { margin-top: 16px; }
        .field { display: grid; gap: 8px; }
        .password-control { position: relative; }
        label {
          color: var(--ink);
          font-size: 0.875rem;
          font-weight: 600;
        }
        input {
          min-height: 44px;
          padding: 8px 12px;
          background: var(--card);
          border: 1px solid var(--line-strong);
          border-radius: 8px;
          transition: border-color 150ms ease;
        }
        .password-control input { padding-right: 44px; }
        button {
          min-height: 44px;
          padding: 8px 16px;
          background: #055088;
          border-color: #055088;
          color: #ffffff;
          border-radius: 8px;
          letter-spacing: 0;
          transition: background-color 150ms ease, border-color 150ms ease, transform 100ms ease;
        }
        input:focus, input:focus-visible, button:focus-visible {
          background: var(--card);
          outline: 3px solid var(--accent);
          outline-offset: 2px;
          box-shadow: none;
        }
        button:hover {
          background: #073f6a;
          border-color: #073f6a;
          box-shadow: none;
        }
        .error, .success, .pending {
          padding: 12px;
          border-radius: 6px;
          line-height: 1.65;
        }
        @media (max-width: 480px) {
          .page-header { padding: 16px; }
          .brand-logo { width: min(224px, 100%); }
          .page-shell { padding: 24px 16px 48px; align-items: start; }
          .container { padding: 24px; }
        }
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) {
            --ink: #f7fafc;
            --ink-soft: #b7c6d1;
            --paper: #0b1f33;
            --card: #12283d;
            --line: #355069;
            --line-strong: #72899b;
            --brand-2: #9fc1f9;
            --danger: #ffb4a6;
            --danger-bg: #3d2325;
            --ok: #8ee2b7;
            --ok-bg: #17392c;
            --info: #9fc1f9;
            --info-bg: #17334c;
          }
          :root:not([data-theme="light"]) .brand-logo-light { display: none; }
          :root:not([data-theme="light"]) .brand-logo-dark { display: block; }
          :root:not([data-theme="light"]) button {
            background: #9fc1f9;
            border-color: #9fc1f9;
            color: #0b1f33;
          }
          :root:not([data-theme="light"]) button:hover {
            background: #b7d1fb;
            border-color: #b7d1fb;
          }
        }
        :root[data-theme="dark"] {
          --ink: #f7fafc;
          --ink-soft: #b7c6d1;
          --paper: #0b1f33;
          --card: #12283d;
          --line: #355069;
          --line-strong: #72899b;
          --brand-2: #9fc1f9;
          --danger: #ffb4a6;
          --danger-bg: #3d2325;
          --ok: #8ee2b7;
          --ok-bg: #17392c;
          --info: #9fc1f9;
          --info-bg: #17334c;
        }
        :root[data-theme="dark"] .brand-logo-light { display: none; }
        :root[data-theme="dark"] .brand-logo-dark { display: block; }
        :root[data-theme="dark"] button {
          background: #9fc1f9;
          border-color: #9fc1f9;
          color: #0b1f33;
        }
        :root[data-theme="dark"] button:hover {
          background: #b7d1fb;
          border-color: #b7d1fb;
        }
        :root .password-control > button.password-toggle {
          position: absolute;
          top: 4px;
          right: 4px;
          min-height: 36px;
          width: 36px;
          padding: 8px;
          background: transparent;
          border: 0;
          border-radius: 0;
          color: var(--brand-2);
          box-shadow: none;
        }
        :root .password-control > button.password-toggle:hover {
          background: transparent;
          color: var(--brand-2);
          box-shadow: none;
        }
        .password-toggle svg {
          display: block;
          width: 18px;
          height: 18px;
          fill: currentColor;
        }
        .password-toggle svg.password-icon-visible { display: none; }
        .password-toggle[aria-pressed="true"] .password-icon-hidden { display: none; }
        .password-toggle[aria-pressed="true"] .password-icon-visible { display: block; }
        .independence-disclaimer {
          display: block;
          margin-top: 4px;
        }`;
}

function renderPage(title: string, body: string) {
  return renderBrandedPage(title, body);
}

export function renderBrandedPage(title: string, body: string) {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(title)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      <style>${renderInteractionPageStyles()}
      </style>
    </head>
    <body>
      <header class="page-header">
        <img class="brand-logo brand-logo-light" src="/logo-auth-color.svg" alt="CQUT Auth 统一身份认证服务">
        <img class="brand-logo brand-logo-dark" src="/logo-auth-mono-light.svg" alt="CQUT Auth 统一身份认证服务">
      </header>
      <div class="page-shell">
        <main class="container">
          ${body}
        </main>
      </div>
    </body>
  </html>`;
}

function loginView(
  response: Response,
  uid: string,
  csrf: string,
  error?: string,
) {
  const scriptNonce = getScriptNonce(response);
  return renderPage(
    "CQUT-Auth",
    `
    <h1>登录</h1>
    <p class="hint">使用知行理工账号登录。密码仅用于本次认证，不会被保存。</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form class="login-form" method="post" action="/interaction/${encodeURIComponent(uid)}/login" data-login-form>
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="field">
        <label for="login-account">账号</label>
        <input id="login-account" type="text" name="account" placeholder="学号/工号" autocomplete="username" required>
      </div>
      <div class="field">
        <label for="login-password">密码</label>
        <div class="password-control">
          <input id="login-password" type="password" name="password" autocomplete="current-password" required>
          <button class="password-toggle" type="button" data-password-toggle aria-controls="login-password" aria-label="显示密码" aria-pressed="false">
            <svg class="password-icon-hidden" viewBox="64 64 896 896" aria-hidden="true" focusable="false">
              <path d="M942.2 486.2Q889.47 375.11 816.7 305l-50.88 50.88C807.31 395.53 843.45 447.4 874.7 512 791.5 684.2 673.4 766 512 766q-72.67 0-133.87-22.38L323 798.75Q408 838 512 838q288.3 0 430.2-300.3a60.29 60.29 0 000-51.5zm-63.57-320.64L836 122.88a8 8 0 00-11.32 0L715.31 232.2Q624.86 186 512 186q-288.3 0-430.2 300.3a60.3 60.3 0 000 51.5q56.69 119.4 136.5 191.41L112.48 835a8 8 0 000 11.31L155.17 889a8 8 0 0011.31 0l712.15-712.12a8 8 0 000-11.32zM149.3 512C232.6 339.8 350.7 258 512 258c54.54 0 104.13 9.36 149.12 28.39l-70.3 70.3a176 176 0 00-238.13 238.13l-83.42 83.42C223.1 637.49 183.3 582.28 149.3 512zm246.7 0a112.11 112.11 0 01146.2-106.69L401.31 546.2A112 112 0 01396 512z"/>
              <path d="M508 624c-3.46 0-6.87-.16-10.25-.47l-52.82 52.82a176.09 176.09 0 00227.42-227.42l-52.82 52.82c.31 3.38.47 6.79.47 10.25a111.94 111.94 0 01-112 112z"/>
            </svg>
            <svg class="password-icon-visible" viewBox="64 64 896 896" aria-hidden="true" focusable="false">
              <path d="M942.2 486.2C847.4 286.5 704.1 186 512 186c-192.2 0-335.4 100.5-430.2 300.3a60.3 60.3 0 000 51.5C176.6 737.5 319.9 838 512 838c192.2 0 335.4-100.5 430.2-300.3 7.7-16.2 7.7-35 0-51.5zM512 766c-161.3 0-279.4-81.8-362.7-254C232.6 339.8 350.7 258 512 258c161.3 0 279.4 81.8 362.7 254C791.5 684.2 673.4 766 512 766zm-4-430c-97.2 0-176 78.8-176 176s78.8 176 176 176 176-78.8 176-176-78.8-176-176zm0 288c-61.9 0-112-50.1-112-112s50.1-112 112-112 112 50.1 112 112-50.1 112-112 112z"/>
            </svg>
          </button>
        </div>
      </div>
      <p class="pending" role="status" aria-live="polite">
        <strong>正在登录</strong>
        正在连接学校统一身份认证，请稍候。
      </p>
      <button type="submit" data-login-submit>
        <span class="button-label">登录账号</span>
        <span class="button-loading">登录中...</span>
      </button>
    </form>
    <p class="independence-note">本服务由 CQUT-OpenProject 提供<span class="independence-disclaimer">* 「CQUT-OpenProject」是由学生及贡献者维护的开源社区，亦不代表学校官方或任何机构</span></p>
    <script nonce="${escapeHtml(scriptNonce)}">
      (() => {
        const form = document.querySelector("[data-login-form]");
        const submit = document.querySelector("[data-login-submit]");
        const password = document.querySelector("#login-password");
        const passwordToggle = document.querySelector("[data-password-toggle]");
        if (!form || !submit) {
          return;
        }
        passwordToggle?.addEventListener("click", () => {
          if (!(password instanceof HTMLInputElement)) {
            return;
          }
          const visible = password.type === "text";
          password.type = visible ? "password" : "text";
          passwordToggle.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
          passwordToggle.setAttribute("aria-pressed", String(!visible));
        });
        let submitted = false;
        form.addEventListener("submit", (event) => {
          if (submitted) {
            event.preventDefault();
            return;
          }
          if (typeof form.checkValidity === "function" && !form.checkValidity()) {
            return;
          }
          submitted = true;
          form.dataset.submitting = "true";
          form.setAttribute("aria-busy", "true");
          submit.setAttribute("disabled", "disabled");
          passwordToggle?.setAttribute("disabled", "disabled");
          for (const field of form.querySelectorAll('input[name="account"], input[name="password"]')) {
            field.setAttribute("readonly", "readonly");
          }
        });
      })();
    </script>
  `,
  );
}

function interactionExpiredView() {
  return renderPage(
    "登录流程已过期",
    `
    <h1>登录流程已过期</h1>
    <p class="error">当前登录授权流程已完成或已过期，请返回业务系统重新发起登录。</p>
  `,
  );
}

function profileEmailView(
  uid: string,
  csrf: string,
  options: {
    email?: string;
    error?: string;
    notice?: string;
    verificationEnabled: boolean;
  },
) {
  const hint = options.verificationEnabled
    ? "请输入您的邮箱地址，系统会发送验证码进行校验。"
    : "请输入您的邮箱地址，系统会以“未验证”状态保存。";
  return renderPage(
    "补充邮箱",
    `
    <h1>补充资料</h1>
    <p class="hint">${escapeHtml(hint)}</p>
    ${options.notice ? `<p class="success">${escapeHtml(options.notice)}</p>` : ""}
    ${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ""}
    <form method="post" action="/interaction/${encodeURIComponent(uid)}/profile">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      ${options.verificationEnabled ? '<input type="hidden" name="action" value="send_code">' : ""}
      <input type="email" name="email" placeholder="邮箱地址" value="${escapeHtml(options.email ?? "")}" autocomplete="email" required>
      <button type="submit">${options.verificationEnabled ? "发送验证码" : "继续"}</button>
    </form>
  `,
  );
}

function profileVerifyCodeView(
  uid: string,
  csrf: string,
  options: {
    email: string;
    error?: string;
    notice?: string;
    resendCooldownSeconds?: number;
  },
) {
  const resendCooldownSeconds = options.resendCooldownSeconds ?? 0;
  const disableResend = resendCooldownSeconds > 0;
  return renderPage(
    "验证邮箱",
    `
    <h1>验证邮箱</h1>
    <p class="hint">验证码已发送到 <strong>${escapeHtml(options.email)}</strong>，请输入 6 位数字验证码。</p>
    ${options.notice ? `<p class="success">${escapeHtml(options.notice)}</p>` : ""}
    ${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ""}
    ${
      disableResend
        ? `<p class="hint">可在 ${resendCooldownSeconds} 秒后重新发送验证码。</p>`
        : '<p class="hint">未收到验证码？可重新发送。</p>'
    }
    <form method="post" action="/interaction/${encodeURIComponent(uid)}/profile">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="action" value="verify_code">
      <input type="text" name="code" placeholder="6位验证码" autocomplete="one-time-code" inputmode="numeric" pattern="\\d{6}" required>
      <button type="submit">验证并继续</button>
    </form>
    <form method="post" action="/interaction/${encodeURIComponent(uid)}/profile">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="action" value="send_code">
      <input type="hidden" name="email" value="${escapeHtml(options.email)}">
      <button type="submit" class="secondary"${disableResend ? " disabled" : ""}>重新发送验证码</button>
    </form>
  `,
  );
}

function generateVerificationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashEmailVerificationCode(
  config: OidcOpConfig,
  uid: string,
  email: string,
  code: string,
) {
  return createHmac("sha256", config.csrfSigningSecret)
    .update(`${uid}:${email}:${code}`)
    .digest("hex");
}

function getResendCooldownSeconds(
  nextResendAt: number,
  now = Math.floor(Date.now() / 1000),
) {
  return Math.max(0, nextResendAt - now);
}

async function finishInteractionLogin(
  provider: any,
  request: Request,
  response: Response,
  pending: PendingInteractionLogin,
) {
  await provider.interactionFinished(
    request,
    response,
    {
      login: {
        accountId: pending.principal.subjectId,
        acr: "urn:cqut:loa:1",
        amr: ["pwd"],
        remember: false,
        ts: pending.authTime,
      },
    },
    { mergeWithLastSubmission: false },
  );
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function consentView(
  response: Response,
  uid: string,
  csrf: string,
  details: any,
  error?: string,
) {
  const scriptNonce = getScriptNonce(response);
  const clientId =
    typeof details?.params?.client_id === "string"
      ? details.params.client_id
      : "未知客户端";
  const requestedScope =
    typeof details?.params?.scope === "string" ? details.params.scope : "";
  const missingScopes = asStringArray(
    details?.prompt?.details?.missingOIDCScope,
  );
  const missingClaims = asStringArray(
    details?.prompt?.details?.missingOIDCClaims,
  );
  const missingResourceScopes = Object.entries(
    details?.prompt?.details?.missingResourceScopes ?? {},
  )
    .map(([indicator, scopes]) => ({
      indicator,
      scopes: asStringArray(scopes),
    }))
    .filter((entry) => entry.scopes.length > 0);
  const sections: string[] = [];

  if (missingScopes.length > 0) {
    sections.push(
      `<p><strong>申请范围：</strong>${escapeHtml(missingScopes.join(" "))}</p>`,
    );
  }
  if (missingClaims.length > 0) {
    sections.push(
      `<p><strong>申请声明：</strong>${escapeHtml(missingClaims.join(", "))}</p>`,
    );
  }
  if (missingResourceScopes.length > 0) {
    sections.push(
      `<p><strong>资源范围：</strong></p><ul>${missingResourceScopes
        .map(
          (entry) =>
            `<li>${escapeHtml(entry.indicator)}: ${escapeHtml(entry.scopes.join(" "))}</li>`,
        )
        .join("")}</ul>`,
    );
  }
  if (sections.length === 0) {
    sections.push('<p class="hint">没有额外申请的权限。</p>');
  }

  return renderPage(
    "确认授权请求",
    `
    <h1>确认授权请求</h1>
    <p class="hint">客户端 <strong>${escapeHtml(clientId)}</strong> 正在请求访问权限。</p>
    ${requestedScope ? `<p class="hint"><strong>请求范围：</strong>${escapeHtml(requestedScope)}</p>` : ""}
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    ${sections.join("")}
    <form class="login-form" method="post" action="/interaction/${encodeURIComponent(uid)}/consent" data-consent-form>
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" value="" data-consent-action>
      <p class="pending" role="status" aria-live="polite">
        <strong>正在处理</strong>
        正在完成授权请求，请稍候。
      </p>
      <button type="submit" name="action" value="approve" data-consent-submit>
        <span class="button-label">允许</span>
        <span class="button-loading">处理中...</span>
      </button>
      <button type="submit" name="action" value="deny" class="secondary" data-consent-submit>拒绝</button>
    </form>
    <script nonce="${escapeHtml(scriptNonce)}">
      (() => {
        const form = document.querySelector("[data-consent-form]");
        if (!form) {
          return;
        }
        let submitted = false;
        let selectedAction = "";
        for (const submit of form.querySelectorAll("[data-consent-submit]")) {
          submit.addEventListener("click", () => {
            selectedAction = submit.value || "";
          });
        }
        form.addEventListener("submit", (event) => {
          if (submitted) {
            event.preventDefault();
            return;
          }
          const submitter = event.submitter;
          const action =
            submitter && "value" in submitter
              ? submitter.value || selectedAction
              : selectedAction;
          const actionInput = form.querySelector("[data-consent-action]");
          if (actionInput && action) {
            actionInput.setAttribute("name", "action");
            actionInput.setAttribute("value", action);
          }
          submitted = true;
          form.dataset.submitting = "true";
          form.setAttribute("aria-busy", "true");
          for (const submit of form.querySelectorAll("[data-consent-submit]")) {
            submit.setAttribute("disabled", "disabled");
          }
        });
      })();
    </script>
  `,
  );
}

function isInteractionSessionNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const status =
    (error as { status?: unknown; statusCode?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  const description = (error as { error_description?: unknown })
    .error_description;
  return (
    error.name === "SessionNotFound" ||
    (status === 400 && description === "interaction session not found")
  );
}

function handleInteractionRouteError(
  error: unknown,
  response: Response,
  next: (error: unknown) => void,
) {
  if (isInteractionSessionNotFound(error)) {
    console.warn("[oidc-op] stale interaction request", error);
    setNoStore(response);
    response.status(400).send(interactionExpiredView());
    return;
  }
  next(error);
}

async function isAutoConsentClient(
  store: OidcPersistence,
  details: any,
): Promise<boolean> {
  const clientId =
    typeof details?.params?.client_id === "string"
      ? details.params.client_id
      : "";
  if (!clientId) {
    return false;
  }
  const client = await store.findOidcClient(clientId);
  return Boolean(client?.autoConsent);
}

async function finishConsent(
  provider: any,
  request: Request,
  response: Response,
  details?: any,
) {
  const interactionDetails =
    details ?? (await provider.interactionDetails(request, response));
  const { prompt, params, session, grantId } = interactionDetails;
  if (prompt.name !== "consent") {
    return false;
  }
  let grant;
  if (grantId) {
    grant = await provider.Grant.find(grantId);
  } else {
    grant = new provider.Grant({
      accountId: session.accountId,
      clientId: String(params.client_id),
    });
  }
  if (prompt.details.missingOIDCScope) {
    grant.addOIDCScope(prompt.details.missingOIDCScope.join(" "));
  }
  if (prompt.details.missingOIDCClaims) {
    grant.addOIDCClaims(prompt.details.missingOIDCClaims);
  }
  if (prompt.details.missingResourceScopes) {
    for (const [indicator, scope] of Object.entries(
      prompt.details.missingResourceScopes,
    )) {
      grant.addResourceScope(indicator, (scope as string[]).join(" "));
    }
  }
  await provider.interactionFinished(
    request,
    response,
    { consent: { grantId: await grant.save() } },
    { mergeWithLastSubmission: true },
  );
  return true;
}

async function denyConsent(
  provider: any,
  request: Request,
  response: Response,
) {
  await provider.interactionFinished(
    request,
    response,
    {
      error: "access_denied",
      error_description: "resource owner denied consent",
    },
    { mergeWithLastSubmission: false },
  );
}

function loginAttemptKey(ip: string, account: string) {
  return `oidc:login:attempt:account-ip:${sha256(account)}:${ip}`;
}

function loginFailureKey(ip: string, account: string) {
  return `oidc:login:failure:account-ip:${sha256(account)}:${ip}`;
}

function loginAttemptAccountKey(account: string) {
  return `oidc:login:attempt:account:${sha256(account)}`;
}

function loginAttemptIpKey(ip: string) {
  return `oidc:login:attempt:ip:${ip}`;
}

function loginFailureAccountKey(account: string) {
  return `oidc:login:failure:account:${sha256(account)}`;
}

function loginFailureIpKey(ip: string) {
  return `oidc:login:failure:ip:${ip}`;
}

async function consumeRateLimitChecks(
  rateLimitService: RateLimitService,
  checks: Array<{ key: string; max: number; windowSeconds: number }>,
): Promise<RateLimitDecision | undefined> {
  for (const check of checks) {
    const decision = await rateLimitService.consume(
      check.key,
      check.max,
      check.windowSeconds,
    );
    if (!decision.allowed) {
      return decision;
    }
  }
  return undefined;
}

async function consumeLoginRateLimit(
  config: OidcOpConfig,
  rateLimitService: RateLimitService,
  identity: {
    ip: string;
    account: string;
  },
  stage: "attempt" | "failure",
): Promise<RateLimitDecision | undefined> {
  const checks =
    stage === "attempt"
      ? [
          {
            key: loginAttemptAccountKey(identity.account),
            max: config.loginRateLimitMax,
            windowSeconds: config.loginRateLimitWindowSeconds,
          },
          {
            key: loginAttemptIpKey(identity.ip),
            max: config.loginRateLimitMax,
            windowSeconds: config.loginRateLimitWindowSeconds,
          },
          {
            key: loginAttemptKey(identity.ip, identity.account),
            max: config.loginRateLimitMax,
            windowSeconds: config.loginRateLimitWindowSeconds,
          },
        ]
      : [
          {
            key: loginFailureAccountKey(identity.account),
            max: config.loginFailureLimit,
            windowSeconds: config.loginFailureWindowSeconds,
          },
          {
            key: loginFailureIpKey(identity.ip),
            max: config.loginFailureLimit,
            windowSeconds: config.loginFailureWindowSeconds,
          },
          {
            key: loginFailureKey(identity.ip, identity.account),
            max: config.loginFailureLimit,
            windowSeconds: config.loginFailureWindowSeconds,
          },
        ];
  return consumeRateLimitChecks(rateLimitService, checks);
}

async function resetLoginFailureRateLimit(
  rateLimitService: RateLimitService,
  identity: {
    ip: string;
    account: string;
  },
) {
  await Promise.all([
    rateLimitService.reset(loginFailureAccountKey(identity.account)),
    rateLimitService.reset(loginFailureKey(identity.ip, identity.account)),
  ]);
}

function emailVerifySubjectRateLimitKey(subjectId: string) {
  return `oidc:email-verify:subject:${subjectId}`;
}

function emailVerifyEmailRateLimitKey(email: string) {
  return `oidc:email-verify:email:${sha256(email)}`;
}

function emailVerifyDomainRateLimitKey(emailDomain: string) {
  return `oidc:email-verify:domain:${sha256(emailDomain)}`;
}

function emailVerifyIpRateLimitKey(ip: string) {
  return `oidc:email-verify:ip:${ip}`;
}

function getEmailDomain(email: string) {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
}

async function consumeEmailVerifyRateLimit(
  config: OidcOpConfig,
  rateLimitService: RateLimitService,
  identity: {
    subjectId: string;
    email: string;
    emailDomain: string;
    ip: string;
  },
): Promise<RateLimitDecision | undefined> {
  return consumeRateLimitChecks(rateLimitService, [
    {
      key: emailVerifySubjectRateLimitKey(identity.subjectId),
      max: config.emailVerifyRateLimitSubjectMax,
      windowSeconds: config.emailVerifyRateLimitSubjectWindowSeconds,
    },
    {
      key: emailVerifyEmailRateLimitKey(identity.email),
      max: config.emailVerifyRateLimitEmailMax,
      windowSeconds: config.emailVerifyRateLimitEmailWindowSeconds,
    },
    {
      key: emailVerifyDomainRateLimitKey(identity.emailDomain),
      max: config.emailVerifyRateLimitDomainMax,
      windowSeconds: config.emailVerifyRateLimitDomainWindowSeconds,
    },
    {
      key: emailVerifyIpRateLimitKey(identity.ip),
      max: config.emailVerifyRateLimitIpMax,
      windowSeconds: config.emailVerifyRateLimitIpWindowSeconds,
    },
  ]);
}

function serviceUnavailableView() {
  return renderPage(
    "服务暂不可用",
    `<p class="error">限流服务暂时不可用，请稍后重试。</p>`,
  );
}

export function createInteractionRouter(
  config: OidcOpConfig,
  provider: any,
  services: OidcServices,
  store: OidcPersistence,
  rateLimitService: RateLimitService,
): express.Router {
  const router = express.Router();
  const formParser = express.urlencoded({
    extended: false,
    limit: "16kb",
    parameterLimit: 10,
  });

  router.get("/:uid", async (request, response, next) => {
    try {
      setNoStore(response);
      const details = await provider.interactionDetails(request, response);
      if (details.prompt.name === "consent") {
        if (await isAutoConsentClient(store, details)) {
          await finishConsent(provider, request, response, details);
          return;
        }
        const uid = request.params["uid"] ?? "";
        const csrf = issueCsrfToken(response, config, uid, "consent");
        response.status(200).send(consentView(response, uid, csrf, details));
        return;
      }
      if (details.prompt.name !== "login") {
        response
          .status(400)
          .send(
            renderPage("不支持的交互类型", "<p>当前交互类型暂不支持。</p>"),
          );
        return;
      }
      const pending = await store.getInteractionLogin(
        request.params["uid"] ?? "",
      );
      if (pending) {
        response.redirect(
          302,
          `/interaction/${encodeURIComponent(request.params["uid"] ?? "")}/profile`,
        );
        return;
      }
      const uid = request.params["uid"] ?? "";
      const csrf = issueCsrfToken(response, config, uid, "login");
      response.status(200).send(loginView(response, uid, csrf));
    } catch (error) {
      handleInteractionRouteError(error, response, next);
    }
  });

  router.post("/:uid/consent", formParser, async (request, response, next) => {
    try {
      setNoStore(response);
      const uid = request.params["uid"] ?? "";
      if (
        !validateCsrf(request, config, {
          uid,
          flow: "consent",
          token:
            typeof request.body?.csrf === "string"
              ? request.body.csrf
              : undefined,
        })
      ) {
        response
          .status(400)
          .send(
            renderPage(
              "无效请求",
              '<p class="error">CSRF 校验失败，请刷新后重试。</p>',
            ),
          );
        return;
      }
      const details = await provider.interactionDetails(request, response);
      if (details.prompt.name !== "consent") {
        response
          .status(400)
          .send(
            renderPage("不支持的交互类型", "<p>当前交互类型暂不支持。</p>"),
          );
        return;
      }
      const action =
        typeof request.body?.action === "string" ? request.body.action : "";
      if (action === "approve") {
        await finishConsent(provider, request, response, details);
        return;
      }
      if (action === "deny") {
        await denyConsent(provider, request, response);
        return;
      }
      const csrf = issueCsrfToken(response, config, uid, "consent");
      response
        .status(400)
        .send(consentView(response, uid, csrf, details, "请选择允许或拒绝。"));
    } catch (error) {
      handleInteractionRouteError(error, response, next);
    }
  });

  router.post("/:uid/login", formParser, async (request, response, next) => {
    try {
      setNoStore(response);
      const uid = request.params["uid"] ?? "";
      if (
        !validateCsrf(request, config, {
          uid,
          flow: "login",
          token:
            typeof request.body?.csrf === "string"
              ? request.body.csrf
              : undefined,
        })
      ) {
        response
          .status(400)
          .send(
            renderPage(
              "无效请求",
              '<p class="error">CSRF 校验失败，请刷新后重试。</p>',
            ),
          );
        return;
      }
      const loginDetails = await provider.interactionDetails(request, response);
      if (loginDetails.prompt.name !== "login" || loginDetails.uid !== uid) {
        response
          .status(400)
          .send(
            renderPage("不支持的交互类型", "<p>当前交互类型暂不支持。</p>"),
          );
        return;
      }
      const account =
        typeof request.body?.account === "string"
          ? request.body.account.trim().toLowerCase()
          : "";
      const password =
        typeof request.body?.password === "string" ? request.body.password : "";
      if (!hasSafeCredentialLengths(account, password)) {
        const csrf = issueCsrfToken(response, config, uid, "login");
        response
          .status(400)
          .send(loginView(response, uid, csrf, "账号或密码长度无效。"));
        return;
      }
      const loginRateLimitIdentity = {
        ip: resolveTrustedExpressRequestIp(config, request),
        account: account || "unknown",
      };
      let precheck;
      try {
        precheck = await consumeLoginRateLimit(
          config,
          rateLimitService,
          loginRateLimitIdentity,
          "attempt",
        );
      } catch (error) {
        if (error instanceof RateLimitUnavailableError) {
          response
            .status(503)
            .setHeader("Retry-After", "60")
            .send(serviceUnavailableView());
          return;
        }
        throw error;
      }
      if (precheck) {
        response
          .status(429)
          .send(
            renderPage(
              "尝试过于频繁",
              `<p class="error">${precheck.retryAfterSeconds} 秒后再试。</p>`,
            ),
          );
        return;
      }

      try {
        const principal = await services.interactiveAuthenticator.authenticate({
          provider: config.authProvider,
          account,
          password,
          ip: loginRateLimitIdentity.ip,
          ...(request.get("user-agent")
            ? { userAgent: request.get("user-agent") as string }
            : {}),
        });
        await resetLoginFailureRateLimit(
          rateLimitService,
          loginRateLimitIdentity,
        ).catch((error) => {
          if (!(error instanceof RateLimitUnavailableError)) {
            throw error;
          }
        });
        const requestedScopes =
          typeof loginDetails.params?.scope === "string"
            ? new Set(loginDetails.params.scope.split(/\s+/).filter(Boolean))
            : new Set<string>();
        if (
          requestedScopes.has("email") &&
          (!principal.email ||
            (config.emailVerificationEnabled && !principal.emailVerified))
        ) {
          await store.saveInteractionLogin(uid, {
            principal,
            authTime: Math.floor(Date.now() / 1000),
          });
          response.redirect(
            302,
            `/interaction/${encodeURIComponent(uid)}/profile`,
          );
          return;
        }
        await finishInteractionLogin(provider, request, response, {
          principal,
          authTime: Math.floor(Date.now() / 1000),
        });
      } catch (error) {
        if (error instanceof RetryableProviderError) {
          console.error(
            "[oidc-op] interactive sign-in upstream unavailable",
            error,
          );
          response
            .status(503)
            .setHeader("Retry-After", "60")
            .send(serviceUnavailableView());
          return;
        }
        let failure;
        try {
          failure = await consumeLoginRateLimit(
            config,
            rateLimitService,
            loginRateLimitIdentity,
            "failure",
          );
        } catch (consumeError) {
          if (consumeError instanceof RateLimitUnavailableError) {
            response
              .status(503)
              .setHeader("Retry-After", "60")
              .send(serviceUnavailableView());
            return;
          }
          throw consumeError;
        }
        if (failure) {
          response
            .status(429)
            .send(
              renderPage(
                "失败次数过多",
                `<p class="error">失败次数过多，请在 ${failure.retryAfterSeconds} 秒后重试。</p>`,
              ),
            );
          return;
        }
        const message = "登录失败，请检查账号或密码后重试。";
        if (error instanceof IdentityCoreError || error instanceof Error) {
          console.error("[oidc-op] interactive sign-in failed", error);
        } else {
          console.error("[oidc-op] interactive sign-in failed", { error });
        }
        const csrf = issueCsrfToken(response, config, uid, "login");
        response.status(401).send(loginView(response, uid, csrf, message));
      }
    } catch (error) {
      handleInteractionRouteError(error, response, next);
    }
  });

  router.get("/:uid/profile", async (request, response, next) => {
    try {
      setNoStore(response);
      const uid = request.params["uid"] ?? "";
      const details = await provider.interactionDetails(request, response);
      if (details.prompt.name !== "login" || details.uid !== uid) {
        response
          .status(400)
          .send(
            renderPage("不支持的交互类型", "<p>当前交互类型暂不支持。</p>"),
          );
        return;
      }
      const pending = await store.getInteractionLogin(uid);
      if (!pending) {
        response.redirect(302, `/interaction/${encodeURIComponent(uid)}`);
        return;
      }
      const csrf = issueCsrfToken(response, config, uid, "profile");
      if (!config.emailVerificationEnabled) {
        response.status(200).send(
          profileEmailView(uid, csrf, {
            verificationEnabled: false,
            ...(pending.principal.email
              ? { email: pending.principal.email }
              : {}),
          }),
        );
        return;
      }
      if (pending.emailVerification) {
        response.status(200).send(
          profileVerifyCodeView(uid, csrf, {
            email: pending.emailVerification.email,
            resendCooldownSeconds: getResendCooldownSeconds(
              pending.emailVerification.nextResendAt,
            ),
          }),
        );
        return;
      }
      response.status(200).send(
        profileEmailView(uid, csrf, {
          verificationEnabled: true,
          ...(pending.principal.email
            ? { email: pending.principal.email }
            : {}),
        }),
      );
    } catch (error) {
      handleInteractionRouteError(error, response, next);
    }
  });

  router.post("/:uid/profile", formParser, async (request, response, next) => {
    try {
      setNoStore(response);
      const uid = request.params["uid"] ?? "";
      const details = await provider.interactionDetails(request, response);
      if (details.prompt.name !== "login" || details.uid !== uid) {
        response
          .status(400)
          .send(
            renderPage("不支持的交互类型", "<p>当前交互类型暂不支持。</p>"),
          );
        return;
      }
      if (
        !validateCsrf(request, config, {
          uid,
          flow: "profile",
          token:
            typeof request.body?.csrf === "string"
              ? request.body.csrf
              : undefined,
        })
      ) {
        response
          .status(400)
          .send(
            renderPage(
              "无效请求",
              '<p class="error">CSRF 校验失败，请刷新后重试。</p>',
            ),
          );
        return;
      }
      const pending = await store.getInteractionLogin(uid);
      if (!pending) {
        response.redirect(302, `/interaction/${encodeURIComponent(uid)}`);
        return;
      }
      if (!config.emailVerificationEnabled) {
        const email =
          typeof request.body?.email === "string"
            ? request.body.email.trim().toLowerCase()
            : "";
        if (!isValidEmail(email)) {
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileEmailView(uid, csrf, {
              email,
              error: "请输入有效的邮箱地址。",
              verificationEnabled: false,
            }),
          );
          return;
        }
        await services.subjectProfileService.setEmail(
          pending.principal.subjectId,
          email,
        );
        await store.deleteInteractionLogin(uid);
        await finishInteractionLogin(provider, request, response, pending);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const action =
        typeof request.body?.action === "string"
          ? request.body.action
          : "send_code";
      if (action === "send_code") {
        const emailRaw =
          typeof request.body?.email === "string"
            ? request.body.email
            : pending.emailVerification?.email;
        const email =
          typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
        if (!isValidEmail(email)) {
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileEmailView(uid, csrf, {
              email,
              error: "请输入有效的邮箱地址。",
              verificationEnabled: true,
            }),
          );
          return;
        }
        if (
          pending.emailVerification &&
          pending.emailVerification.email === email &&
          pending.emailVerification.nextResendAt > now
        ) {
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(429).send(
            profileVerifyCodeView(uid, csrf, {
              email,
              error: `请在 ${pending.emailVerification.nextResendAt - now} 秒后再重试发送。`,
              resendCooldownSeconds:
                pending.emailVerification.nextResendAt - now,
            }),
          );
          return;
        }

        const ip = resolveTrustedExpressRequestIp(config, request);
        const emailDomain = getEmailDomain(email);
        let globalRateLimitDecision: RateLimitDecision | undefined;
        try {
          globalRateLimitDecision = await consumeEmailVerifyRateLimit(
            config,
            rateLimitService,
            {
              subjectId: pending.principal.subjectId,
              email,
              emailDomain,
              ip,
            },
          );
        } catch (error) {
          if (error instanceof RateLimitUnavailableError) {
            response
              .status(503)
              .setHeader("Retry-After", "60")
              .send(serviceUnavailableView());
            return;
          }
          throw error;
        }
        if (globalRateLimitDecision && !globalRateLimitDecision.allowed) {
          const retryAfterSeconds = globalRateLimitDecision.retryAfterSeconds;
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.setHeader("Retry-After", String(retryAfterSeconds));
          const errorMessage = `发送过于频繁，请在 ${retryAfterSeconds} 秒后再试。`;
          if (
            pending.emailVerification &&
            pending.emailVerification.email === email
          ) {
            response.status(429).send(
              profileVerifyCodeView(uid, csrf, {
                email,
                error: errorMessage,
                resendCooldownSeconds: retryAfterSeconds,
              }),
            );
            return;
          }
          response.status(429).send(
            profileEmailView(uid, csrf, {
              email,
              error: errorMessage,
              verificationEnabled: true,
            }),
          );
          return;
        }

        const code = generateVerificationCode();
        try {
          await services.emailSender.sendVerificationCode({
            to: email,
            code,
            interactionUid: uid,
            expiresInSeconds: config.emailVerifyCodeTtlSeconds,
          });
        } catch (error) {
          console.error("[oidc-op] email verification send failed", error);
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(503).send(
            profileEmailView(uid, csrf, {
              email,
              error: "验证码发送失败，请稍后重试。",
              verificationEnabled: true,
            }),
          );
          return;
        }

        const updatedPending: PendingInteractionLogin = {
          ...pending,
          emailVerification: {
            email,
            codeHash: hashEmailVerificationCode(config, uid, email, code),
            expiresAt: now + config.emailVerifyCodeTtlSeconds,
            attempts: 0,
            nextResendAt: now + config.emailVerifyResendCooldownSeconds,
          },
        };
        await store.saveInteractionLogin(uid, updatedPending);
        const csrf = issueCsrfToken(response, config, uid, "profile");
        response.status(200).send(
          profileVerifyCodeView(uid, csrf, {
            email,
            notice: "验证码已发送，请前往邮箱查看。",
            resendCooldownSeconds: config.emailVerifyResendCooldownSeconds,
          }),
        );
        return;
      }

      if (action === "verify_code") {
        const verification = pending.emailVerification;
        if (!verification) {
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileEmailView(uid, csrf, {
              error: "请先发送验证码。",
              verificationEnabled: true,
              ...(pending.principal.email
                ? { email: pending.principal.email }
                : {}),
            }),
          );
          return;
        }
        if (verification.expiresAt <= now) {
          await store.saveInteractionLogin(uid, {
            principal: pending.principal,
            authTime: pending.authTime,
          });
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileEmailView(uid, csrf, {
              email: verification.email,
              error: "验证码已过期，请重新发送。",
              verificationEnabled: true,
            }),
          );
          return;
        }
        if (verification.attempts >= config.emailVerifyMaxAttempts) {
          await store.saveInteractionLogin(uid, {
            principal: pending.principal,
            authTime: pending.authTime,
          });
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileEmailView(uid, csrf, {
              email: verification.email,
              error: "验证码尝试次数过多，请重新发送。",
              verificationEnabled: true,
            }),
          );
          return;
        }

        const code =
          typeof request.body?.code === "string"
            ? request.body.code.trim()
            : "";
        if (!/^\d{6}$/.test(code)) {
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileVerifyCodeView(uid, csrf, {
              email: verification.email,
              error: "请输入 6 位数字验证码。",
              resendCooldownSeconds: getResendCooldownSeconds(
                verification.nextResendAt,
                now,
              ),
            }),
          );
          return;
        }
        const inputHash = hashEmailVerificationCode(
          config,
          uid,
          verification.email,
          code,
        );
        if (!secureStringEqual(inputHash, verification.codeHash)) {
          const nextAttempts = verification.attempts + 1;
          if (nextAttempts >= config.emailVerifyMaxAttempts) {
            await store.saveInteractionLogin(uid, {
              principal: pending.principal,
              authTime: pending.authTime,
            });
            const csrf = issueCsrfToken(response, config, uid, "profile");
            response.status(400).send(
              profileEmailView(uid, csrf, {
                email: verification.email,
                error: "验证码尝试次数过多，请重新发送。",
                verificationEnabled: true,
              }),
            );
            return;
          }
          await store.saveInteractionLogin(uid, {
            ...pending,
            emailVerification: {
              ...verification,
              attempts: nextAttempts,
            },
          });
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileVerifyCodeView(uid, csrf, {
              email: verification.email,
              error: `验证码错误，还可尝试 ${config.emailVerifyMaxAttempts - nextAttempts} 次。`,
              resendCooldownSeconds: getResendCooldownSeconds(
                verification.nextResendAt,
                now,
              ),
            }),
          );
          return;
        }

        await services.subjectProfileService.setVerifiedEmail(
          pending.principal.subjectId,
          verification.email,
        );
        await store.deleteInteractionLogin(uid);
        await finishInteractionLogin(provider, request, response, pending);
        return;
      }

      const csrf = issueCsrfToken(response, config, uid, "profile");
      response.status(400).send(
        profileEmailView(uid, csrf, {
          error: "无效操作，请重试。",
          verificationEnabled: true,
          ...(pending.principal.email
            ? { email: pending.principal.email }
            : {}),
        }),
      );
    } catch (error) {
      handleInteractionRouteError(error, response, next);
    }
  });

  return router;
}
