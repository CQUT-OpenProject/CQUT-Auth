import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { IdentityCoreError } from "@cqut/identity-core";
import express, { type Request, type Response } from "express";
import type { OidcOpConfig } from "../config.js";
import {
  RateLimitUnavailableError,
  type RateLimitDecision,
  type RateLimitService
} from "../persistence/rate-limit.service.js";
import type { OidcPersistence, PendingInteractionLogin } from "../persistence/contracts.js";
import type { OidcServices } from "../oidc/provider.js";
import {
  base64Url,
  escapeHtml,
  isValidEmail,
  parseCookies,
  randomId,
  sha256,
  sha256Base64Url
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

function setCsrfNonceCookie(response: Response, config: OidcOpConfig, nonce: string) {
  response.cookie(CSRF_NONCE_COOKIE_NAME, nonce, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/"
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
  return base64Url(createHmac("sha256", secret).update(payloadBase64Url).digest());
}

function issueCsrfToken(response: Response, config: OidcOpConfig, uid: string, flow: CsrfFlow): string {
  const nonce = randomId("csrfn");
  setCsrfNonceCookie(response, config, nonce);
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: CsrfTokenPayload = {
    uid,
    flow,
    iat: issuedAt,
    exp: issuedAt + config.csrfTokenTtlSeconds,
    nonce_hash: sha256Base64Url(nonce)
  };
  const payloadBase64Url = base64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = signCsrfPayload(payloadBase64Url, config.csrfSigningSecret);
  return `${payloadBase64Url}.${signature}`;
}

function parseAndValidateCsrfPayload(token: string, secret: string): CsrfTokenPayload | null {
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
    const parsed = JSON.parse(decodeBase64Url(payloadBase64Url).toString("utf8")) as Partial<CsrfTokenPayload>;
    if (
      typeof parsed.uid !== "string" ||
      (parsed.flow !== "login" && parsed.flow !== "profile" && parsed.flow !== "consent") ||
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
  expected: { uid: string; flow: CsrfFlow; token: string | undefined }
): boolean {
  if (!expected.token) {
    return false;
  }
  const payload = parseAndValidateCsrfPayload(expected.token, config.csrfSigningSecret);
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

function renderPage(title: string, body: string) {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(title)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; margin: 2rem auto; max-width: 28rem; padding: 0 1rem; }
        form { display: grid; gap: 0.75rem; }
        input { padding: 0.75rem; font-size: 1rem; }
        button { padding: 0.8rem 1rem; font-size: 1rem; }
        .error { color: #b42318; }
        .success { color: #067647; }
        .hint { color: #475467; font-size: 0.95rem; }
        .secondary { background: #f2f4f7; border: 1px solid #d0d5dd; }
      </style>
    </head>
    <body>
      ${body}
    </body>
  </html>`;
}

function loginView(uid: string, csrf: string, error?: string) {
  return renderPage(
    "CQUT-Auth",
    `
    <h1>CQUT-Auth</h1>
    <p class="hint">请使用知行理工账号登录。</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/interaction/${encodeURIComponent(uid)}/login">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="text" name="account" placeholder="账号" autocomplete="username" required>
      <input type="password" name="password" placeholder="密码" autocomplete="current-password" required>
      <button type="submit">登录</button>
    </form>
  `
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
  }
) {
  const hint = options.verificationEnabled
    ? "请输入用于 OpenID Connect 声明的邮箱地址，系统会发送验证码进行校验。"
    : "请输入用于 OpenID Connect 声明的邮箱地址，系统会以“未验证”状态保存。";
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
  `
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
  }
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
        : "<p class=\"hint\">未收到验证码？可重新发送。</p>"
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
  `
  );
}

function generateVerificationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashEmailVerificationCode(config: OidcOpConfig, uid: string, email: string, code: string) {
  return createHmac("sha256", config.csrfSigningSecret).update(`${uid}:${email}:${code}`).digest("hex");
}

function getResendCooldownSeconds(nextResendAt: number, now = Math.floor(Date.now() / 1000)) {
  return Math.max(0, nextResendAt - now);
}

async function finishInteractionLogin(
  provider: any,
  request: Request,
  response: Response,
  pending: PendingInteractionLogin
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
        ts: pending.authTime
      }
    },
    { mergeWithLastSubmission: false }
  );
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function consentView(uid: string, csrf: string, details: any, error?: string) {
  const clientId = typeof details?.params?.client_id === "string" ? details.params.client_id : "未知客户端";
  const requestedScope = typeof details?.params?.scope === "string" ? details.params.scope : "";
  const missingScopes = asStringArray(details?.prompt?.details?.missingOIDCScope);
  const missingClaims = asStringArray(details?.prompt?.details?.missingOIDCClaims);
  const missingResourceScopes = Object.entries(details?.prompt?.details?.missingResourceScopes ?? {})
    .map(([indicator, scopes]) => ({
      indicator,
      scopes: asStringArray(scopes)
    }))
    .filter((entry) => entry.scopes.length > 0);
  const sections: string[] = [];

  if (missingScopes.length > 0) {
    sections.push(`<p><strong>申请范围：</strong>${escapeHtml(missingScopes.join(" "))}</p>`);
  }
  if (missingClaims.length > 0) {
    sections.push(`<p><strong>申请声明：</strong>${escapeHtml(missingClaims.join(", "))}</p>`);
  }
  if (missingResourceScopes.length > 0) {
    sections.push(
      `<p><strong>资源范围：</strong></p><ul>${missingResourceScopes
        .map(
          (entry) =>
            `<li>${escapeHtml(entry.indicator)}: ${escapeHtml(entry.scopes.join(" "))}</li>`
        )
        .join("")}</ul>`
    );
  }
  if (sections.length === 0) {
    sections.push("<p class=\"hint\">没有额外申请的权限。</p>");
  }

  return renderPage(
    "确认授权请求",
    `
    <h1>确认授权请求</h1>
    <p class="hint">客户端 <strong>${escapeHtml(clientId)}</strong> 正在请求访问权限。</p>
    ${requestedScope ? `<p class="hint"><strong>请求范围：</strong>${escapeHtml(requestedScope)}</p>` : ""}
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    ${sections.join("")}
    <form method="post" action="/interaction/${encodeURIComponent(uid)}/consent">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button type="submit" name="action" value="approve">允许</button>
      <button type="submit" name="action" value="deny">拒绝</button>
    </form>
  `
  );
}

async function isAutoConsentClient(store: OidcPersistence, details: any): Promise<boolean> {
  const clientId = typeof details?.params?.client_id === "string" ? details.params.client_id : "";
  if (!clientId) {
    return false;
  }
  const client = await store.findOidcClient(clientId);
  return Boolean(client?.autoConsent);
}

async function finishConsent(provider: any, request: Request, response: Response, details?: any) {
  const interactionDetails = details ?? (await provider.interactionDetails(request, response));
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
      clientId: String(params.client_id)
    });
  }
  if (prompt.details.missingOIDCScope) {
    grant.addOIDCScope(prompt.details.missingOIDCScope.join(" "));
  }
  if (prompt.details.missingOIDCClaims) {
    grant.addOIDCClaims(prompt.details.missingOIDCClaims);
  }
  if (prompt.details.missingResourceScopes) {
    for (const [indicator, scope] of Object.entries(prompt.details.missingResourceScopes)) {
      grant.addResourceScope(indicator, (scope as string[]).join(" "));
    }
  }
  await provider.interactionFinished(
    request,
    response,
    { consent: { grantId: await grant.save() } },
    { mergeWithLastSubmission: true }
  );
  return true;
}

async function denyConsent(provider: any, request: Request, response: Response) {
  await provider.interactionFinished(
    request,
    response,
    {
      error: "access_denied",
      error_description: "resource owner denied consent"
    },
    { mergeWithLastSubmission: false }
  );
}

function loginAttemptKey(ip: string, account: string) {
  return `oidc:login:${ip}:${account}`;
}

function loginFailureKey(ip: string, account: string) {
  return `oidc:login-failure:${ip}:${account}`;
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
  }
): Promise<RateLimitDecision | undefined> {
  const checks: Array<{ key: string; max: number; windowSeconds: number }> = [
    {
      key: emailVerifySubjectRateLimitKey(identity.subjectId),
      max: config.emailVerifyRateLimitSubjectMax,
      windowSeconds: config.emailVerifyRateLimitSubjectWindowSeconds
    },
    {
      key: emailVerifyEmailRateLimitKey(identity.email),
      max: config.emailVerifyRateLimitEmailMax,
      windowSeconds: config.emailVerifyRateLimitEmailWindowSeconds
    },
    {
      key: emailVerifyDomainRateLimitKey(identity.emailDomain),
      max: config.emailVerifyRateLimitDomainMax,
      windowSeconds: config.emailVerifyRateLimitDomainWindowSeconds
    },
    {
      key: emailVerifyIpRateLimitKey(identity.ip),
      max: config.emailVerifyRateLimitIpMax,
      windowSeconds: config.emailVerifyRateLimitIpWindowSeconds
    }
  ];
  for (const check of checks) {
    const decision = await rateLimitService.consume(check.key, check.max, check.windowSeconds);
    if (!decision.allowed) {
      return decision;
    }
  }
  return undefined;
}

function serviceUnavailableView() {
  return renderPage(
    "服务暂不可用",
    `<p class="error">限流服务暂时不可用，请稍后重试。</p>`
  );
}

export function createInteractionRouter(
  config: OidcOpConfig,
  provider: any,
  services: OidcServices,
  store: OidcPersistence,
  rateLimitService: RateLimitService
): express.Router {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 10 });

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
        response.status(200).send(consentView(uid, csrf, details));
        return;
      }
      if (details.prompt.name !== "login") {
        response.status(400).send(renderPage("不支持的交互类型", "<p>当前交互类型暂不支持。</p>"));
        return;
      }
      const pending = await store.getInteractionLogin(request.params["uid"] ?? "");
      if (pending) {
        response.redirect(302, `/interaction/${encodeURIComponent(request.params["uid"] ?? "")}/profile`);
        return;
      }
      const uid = request.params["uid"] ?? "";
      const csrf = issueCsrfToken(response, config, uid, "login");
      response.status(200).send(loginView(uid, csrf));
    } catch (error) {
      next(error);
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
          token: typeof request.body?.csrf === "string" ? request.body.csrf : undefined
        })
      ) {
        response.status(400).send(renderPage("无效请求", "<p class=\"error\">CSRF 校验失败，请刷新后重试。</p>"));
        return;
      }
      const details = await provider.interactionDetails(request, response);
      if (details.prompt.name !== "consent") {
        response.status(400).send(renderPage("不支持的交互类型", "<p>当前交互类型暂不支持。</p>"));
        return;
      }
      const action = typeof request.body?.action === "string" ? request.body.action : "";
      if (action === "approve") {
        await finishConsent(provider, request, response, details);
        return;
      }
      if (action === "deny") {
        await denyConsent(provider, request, response);
        return;
      }
      const csrf = issueCsrfToken(response, config, uid, "consent");
      response.status(400).send(consentView(uid, csrf, details, "请选择允许或拒绝。"));
    } catch (error) {
      next(error);
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
          token: typeof request.body?.csrf === "string" ? request.body.csrf : undefined
        })
      ) {
        response.status(400).send(renderPage("无效请求", "<p class=\"error\">CSRF 校验失败，请刷新后重试。</p>"));
        return;
      }
      const account = typeof request.body?.account === "string" ? request.body.account.trim() : "";
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
      let precheck;
      try {
        precheck = await rateLimitService.consume(
          loginAttemptKey(ip, account || "unknown"),
          config.loginRateLimitMax,
          config.loginRateLimitWindowSeconds
        );
      } catch (error) {
        if (error instanceof RateLimitUnavailableError) {
          response.status(503).setHeader("Retry-After", "60").send(serviceUnavailableView());
          return;
        }
        throw error;
      }
      if (!precheck.allowed) {
        response.status(429).send(renderPage("尝试过于频繁", `<p class="error">${precheck.retryAfterSeconds} 秒后再试。</p>`));
        return;
      }

      try {
        const principal = await services.interactiveAuthenticator.authenticate({
          provider: config.authProvider,
          account,
          password,
          ip,
          ...(request.get("user-agent") ? { userAgent: request.get("user-agent") as string } : {})
        });
        await rateLimitService.reset(loginFailureKey(ip, account || "unknown")).catch((error) => {
          if (!(error instanceof RateLimitUnavailableError)) {
            throw error;
          }
        });
        if (!principal.email || (config.emailVerificationEnabled && !principal.emailVerified)) {
          await store.saveInteractionLogin(uid, {
            principal,
            authTime: Math.floor(Date.now() / 1000)
          });
          response.redirect(302, `/interaction/${encodeURIComponent(uid)}/profile`);
          return;
        }
        await finishInteractionLogin(provider, request, response, {
          principal,
          authTime: Math.floor(Date.now() / 1000)
        });
      } catch (error) {
        let failure;
        try {
          failure = await rateLimitService.consume(
            loginFailureKey(ip, account || "unknown"),
            config.loginFailureLimit,
            config.loginFailureWindowSeconds
          );
        } catch (consumeError) {
          if (consumeError instanceof RateLimitUnavailableError) {
            response.status(503).setHeader("Retry-After", "60").send(serviceUnavailableView());
            return;
          }
          throw consumeError;
        }
        if (!failure.allowed) {
          response.status(429).send(renderPage("失败次数过多", `<p class="error">失败次数过多，请在 ${failure.retryAfterSeconds} 秒后重试。</p>`));
          return;
        }
        const message = "登录失败，请检查账号或密码后重试。";
        if (error instanceof IdentityCoreError || error instanceof Error) {
          console.error("[oidc-op] interactive sign-in failed", error);
        } else {
          console.error("[oidc-op] interactive sign-in failed", { error });
        }
        const csrf = issueCsrfToken(response, config, uid, "login");
        response.status(401).send(loginView(uid, csrf, message));
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/:uid/profile", async (request, response, next) => {
    try {
      setNoStore(response);
      const uid = request.params["uid"] ?? "";
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
            ...(pending.principal.email ? { email: pending.principal.email } : {})
          })
        );
        return;
      }
      if (pending.emailVerification) {
        response.status(200).send(
          profileVerifyCodeView(uid, csrf, {
            email: pending.emailVerification.email,
            resendCooldownSeconds: getResendCooldownSeconds(pending.emailVerification.nextResendAt)
          })
        );
        return;
      }
      response.status(200).send(
        profileEmailView(uid, csrf, {
          verificationEnabled: true,
          ...(pending.principal.email ? { email: pending.principal.email } : {})
        })
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/:uid/profile", formParser, async (request, response, next) => {
    try {
      setNoStore(response);
      const uid = request.params["uid"] ?? "";
      if (
        !validateCsrf(request, config, {
          uid,
          flow: "profile",
          token: typeof request.body?.csrf === "string" ? request.body.csrf : undefined
        })
      ) {
        response.status(400).send(renderPage("无效请求", "<p class=\"error\">CSRF 校验失败，请刷新后重试。</p>"));
        return;
      }
      const pending = await store.getInteractionLogin(uid);
      if (!pending) {
        response.redirect(302, `/interaction/${encodeURIComponent(uid)}`);
        return;
      }
      if (!config.emailVerificationEnabled) {
        const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
        if (!isValidEmail(email)) {
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileEmailView(uid, csrf, {
              email,
              error: "请输入有效的邮箱地址。",
              verificationEnabled: false
            })
          );
          return;
        }
        await services.subjectProfileService.setEmail(pending.principal.subjectId, email);
        await store.deleteInteractionLogin(uid);
        await finishInteractionLogin(provider, request, response, pending);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const action = typeof request.body?.action === "string" ? request.body.action : "send_code";
      if (action === "send_code") {
        const emailRaw =
          typeof request.body?.email === "string" ? request.body.email : pending.emailVerification?.email;
        const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
        if (!isValidEmail(email)) {
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileEmailView(uid, csrf, {
              email,
              error: "请输入有效的邮箱地址。",
              verificationEnabled: true
            })
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
              resendCooldownSeconds: pending.emailVerification.nextResendAt - now
            })
          );
          return;
        }

        const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
        const emailDomain = getEmailDomain(email);
        let globalRateLimitDecision: RateLimitDecision | undefined;
        try {
          globalRateLimitDecision = await consumeEmailVerifyRateLimit(config, rateLimitService, {
            subjectId: pending.principal.subjectId,
            email,
            emailDomain,
            ip
          });
        } catch (error) {
          if (error instanceof RateLimitUnavailableError) {
            response.status(503).setHeader("Retry-After", "60").send(serviceUnavailableView());
            return;
          }
          throw error;
        }
        if (globalRateLimitDecision && !globalRateLimitDecision.allowed) {
          const retryAfterSeconds = globalRateLimitDecision.retryAfterSeconds;
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.setHeader("Retry-After", String(retryAfterSeconds));
          const errorMessage = `发送过于频繁，请在 ${retryAfterSeconds} 秒后再试。`;
          if (pending.emailVerification && pending.emailVerification.email === email) {
            response.status(429).send(
              profileVerifyCodeView(uid, csrf, {
                email,
                error: errorMessage,
                resendCooldownSeconds: retryAfterSeconds
              })
            );
            return;
          }
          response.status(429).send(
            profileEmailView(uid, csrf, {
              email,
              error: errorMessage,
              verificationEnabled: true
            })
          );
          return;
        }

        const code = generateVerificationCode();
        try {
          await services.emailSender.sendVerificationCode({
            to: email,
            code,
            interactionUid: uid,
            expiresInSeconds: config.emailVerifyCodeTtlSeconds
          });
        } catch (error) {
          console.error("[oidc-op] email verification send failed", error);
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(503).send(
            profileEmailView(uid, csrf, {
              email,
              error: "验证码发送失败，请稍后重试。",
              verificationEnabled: true
            })
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
            nextResendAt: now + config.emailVerifyResendCooldownSeconds
          }
        };
        await store.saveInteractionLogin(uid, updatedPending);
        const csrf = issueCsrfToken(response, config, uid, "profile");
        response.status(200).send(
          profileVerifyCodeView(uid, csrf, {
            email,
            notice: "验证码已发送，请前往邮箱查看。",
            resendCooldownSeconds: config.emailVerifyResendCooldownSeconds
          })
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
              ...(pending.principal.email ? { email: pending.principal.email } : {})
            })
          );
          return;
        }
        if (verification.expiresAt <= now) {
          await store.saveInteractionLogin(uid, {
            principal: pending.principal,
            authTime: pending.authTime
          });
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileEmailView(uid, csrf, {
              email: verification.email,
              error: "验证码已过期，请重新发送。",
              verificationEnabled: true
            })
          );
          return;
        }
        if (verification.attempts >= config.emailVerifyMaxAttempts) {
          await store.saveInteractionLogin(uid, {
            principal: pending.principal,
            authTime: pending.authTime
          });
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileEmailView(uid, csrf, {
              email: verification.email,
              error: "验证码尝试次数过多，请重新发送。",
              verificationEnabled: true
            })
          );
          return;
        }

        const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
        if (!/^\d{6}$/.test(code)) {
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileVerifyCodeView(uid, csrf, {
              email: verification.email,
              error: "请输入 6 位数字验证码。",
              resendCooldownSeconds: getResendCooldownSeconds(verification.nextResendAt, now)
            })
          );
          return;
        }
        const inputHash = hashEmailVerificationCode(config, uid, verification.email, code);
        if (!secureStringEqual(inputHash, verification.codeHash)) {
          const nextAttempts = verification.attempts + 1;
          if (nextAttempts >= config.emailVerifyMaxAttempts) {
            await store.saveInteractionLogin(uid, {
              principal: pending.principal,
              authTime: pending.authTime
            });
            const csrf = issueCsrfToken(response, config, uid, "profile");
            response.status(400).send(
              profileEmailView(uid, csrf, {
                email: verification.email,
                error: "验证码尝试次数过多，请重新发送。",
                verificationEnabled: true
              })
            );
            return;
          }
          await store.saveInteractionLogin(uid, {
            ...pending,
            emailVerification: {
              ...verification,
              attempts: nextAttempts
            }
          });
          const csrf = issueCsrfToken(response, config, uid, "profile");
          response.status(400).send(
            profileVerifyCodeView(uid, csrf, {
              email: verification.email,
              error: `验证码错误，还可尝试 ${config.emailVerifyMaxAttempts - nextAttempts} 次。`,
              resendCooldownSeconds: getResendCooldownSeconds(verification.nextResendAt, now)
            })
          );
          return;
        }

        await services.subjectProfileService.setVerifiedEmail(
          pending.principal.subjectId,
          verification.email
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
          ...(pending.principal.email ? { email: pending.principal.email } : {})
        })
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
