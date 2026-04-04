import { IdentityCoreError } from "@cqut/identity-core";
import express, { type Request, type Response } from "express";
import type { OidcOpConfig } from "../config.js";
import type { RateLimitService } from "../persistence/rate-limit.service.js";
import type { OidcArtifactRepository } from "../persistence/contracts.js";
import type { OidcServices } from "../oidc/provider.js";
import { escapeHtml, isValidEmail, parseCookies, randomId } from "../utils.js";

function setNoStore(response: Response) {
  response.setHeader("Cache-Control", "no-store");
}

function setCsrfCookie(response: Response, config: OidcOpConfig, token: string) {
  response.cookie("op_csrf", token, {
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/"
  });
}

function validateCsrf(request: Request, expected: string | undefined): boolean {
  const cookies = parseCookies(request.headers.cookie);
  return Boolean(expected && cookies["op_csrf"] && expected === cookies["op_csrf"]);
}

function renderPage(title: string, body: string) {
  return `<!DOCTYPE html>
  <html>
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
        .hint { color: #475467; font-size: 0.95rem; }
      </style>
    </head>
    <body>
      ${body}
    </body>
  </html>`;
}

function loginView(uid: string, csrf: string, error?: string) {
  return renderPage(
    "CQUT Sign In",
    `
    <h1>CQUT Sign In</h1>
    <p class="hint">Use your campus account to continue.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/interaction/${encodeURIComponent(uid)}/login">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="text" name="account" placeholder="Campus account" autocomplete="username" required>
      <input type="password" name="password" placeholder="Campus password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  `
  );
}

function profileView(uid: string, csrf: string, email?: string, error?: string) {
  return renderPage(
    "Add Email",
    `
    <h1>Complete Your Profile</h1>
    <p class="hint">Add an email address for OpenID Connect claims. It will be stored as unverified.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/interaction/${encodeURIComponent(uid)}/profile">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="email" name="email" placeholder="Email address" value="${escapeHtml(email ?? "")}" autocomplete="email" required>
      <button type="submit">Continue</button>
    </form>
  `
  );
}

async function finishConsent(provider: any, request: Request, response: Response) {
  const details = await provider.interactionDetails(request, response);
  const { prompt, params, session, grantId } = details;
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

function loginAttemptKey(ip: string, account: string) {
  return `oidc:login:${ip}:${account}`;
}

function loginFailureKey(ip: string, account: string) {
  return `oidc:login-failure:${ip}:${account}`;
}

export function createInteractionRouter(
  config: OidcOpConfig,
  provider: any,
  services: OidcServices,
  store: OidcArtifactRepository,
  rateLimitService: RateLimitService
): express.Router {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 10 });

  router.get("/:uid", async (request, response, next) => {
    try {
      setNoStore(response);
      if (await finishConsent(provider, request, response)) {
        return;
      }
      const details = await provider.interactionDetails(request, response);
      if (details.prompt.name !== "login") {
        response.status(400).send(renderPage("Unsupported Prompt", "<p>Unsupported interaction prompt.</p>"));
        return;
      }
      const pending = await store.getInteractionLogin(request.params["uid"] ?? "");
      if (pending) {
        response.redirect(302, `/interaction/${encodeURIComponent(request.params["uid"] ?? "")}/profile`);
        return;
      }
      const csrf = randomId("csrf");
      setCsrfCookie(response, config, csrf);
      response.status(200).send(loginView(request.params["uid"] ?? "", csrf));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:uid/login", formParser, async (request, response, next) => {
    try {
      setNoStore(response);
      const uid = request.params["uid"] ?? "";
      if (!validateCsrf(request, typeof request.body?.csrf === "string" ? request.body.csrf : undefined)) {
        response.status(400).send(renderPage("Invalid Request", "<p class=\"error\">Invalid CSRF token.</p>"));
        return;
      }
      const account = typeof request.body?.account === "string" ? request.body.account.trim() : "";
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
      const precheck = await rateLimitService.consume(
        loginAttemptKey(ip, account || "unknown"),
        config.loginRateLimitMax,
        config.loginRateLimitWindowSeconds
      );
      if (!precheck.allowed) {
        response.status(429).send(renderPage("Too Many Attempts", `<p class="error">Try again in ${precheck.retryAfterSeconds} seconds.</p>`));
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
        await rateLimitService.reset(loginFailureKey(ip, account || "unknown"));
        if (!principal.email) {
          await store.saveInteractionLogin(uid, {
            principal,
            authTime: Math.floor(Date.now() / 1000)
          });
          response.redirect(302, `/interaction/${encodeURIComponent(uid)}/profile`);
          return;
        }
        await provider.interactionFinished(
          request,
          response,
          {
            login: {
              accountId: principal.subjectId,
              acr: "urn:cqut:loa:1",
              amr: ["pwd"],
              remember: false,
              ts: Math.floor(Date.now() / 1000)
            }
          },
          { mergeWithLastSubmission: false }
        );
      } catch (error) {
        const failure = await rateLimitService.consume(
          loginFailureKey(ip, account || "unknown"),
          config.loginFailureLimit,
          config.loginFailureWindowSeconds
        );
        if (!failure.allowed) {
          response.status(429).send(renderPage("Too Many Failures", `<p class="error">Too many failed sign-in attempts. Retry in ${failure.retryAfterSeconds} seconds.</p>`));
          return;
        }
        const message =
          error instanceof IdentityCoreError ? error.message : error instanceof Error ? error.message : "sign-in failed";
        const csrf = randomId("csrf");
        setCsrfCookie(response, config, csrf);
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
      const csrf = randomId("csrf");
      setCsrfCookie(response, config, csrf);
      response.status(200).send(profileView(uid, csrf, pending.principal.email));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:uid/profile", formParser, async (request, response, next) => {
    try {
      setNoStore(response);
      const uid = request.params["uid"] ?? "";
      if (!validateCsrf(request, typeof request.body?.csrf === "string" ? request.body.csrf : undefined)) {
        response.status(400).send(renderPage("Invalid Request", "<p class=\"error\">Invalid CSRF token.</p>"));
        return;
      }
      const pending = await store.getInteractionLogin(uid);
      if (!pending) {
        response.redirect(302, `/interaction/${encodeURIComponent(uid)}`);
        return;
      }
      const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
      if (!isValidEmail(email)) {
        const csrf = randomId("csrf");
        setCsrfCookie(response, config, csrf);
        response.status(400).send(profileView(uid, csrf, email, "Enter a valid email address."));
        return;
      }

      await services.subjectProfileService.setEmail(pending.principal.subjectId, email);
      await store.deleteInteractionLogin(uid);
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
    } catch (error) {
      next(error);
    }
  });

  return router;
}
