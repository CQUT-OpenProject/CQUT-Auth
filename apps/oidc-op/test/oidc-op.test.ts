import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import request from "supertest";
import { createOidcApp } from "../src/app.js";
import { readOidcOpConfig } from "../src/config.js";
import {
  createClientSecretDigest,
  decryptJson,
  encryptJson,
  verifyClientSecretDigest
} from "../src/crypto.js";
import type { EmailSender, SendVerificationCodeInput } from "../src/email/email-sender.js";
import { computeSessionTtlSeconds, generateSigningKey } from "../src/oidc/provider.js";
import { sha256Base64Url } from "../src/utils.js";

const TEST_REDIRECT_URI = "http://localhost:3002/demo/callback";
const TEST_POST_LOGOUT_REDIRECT_URI = "http://localhost:3002/demo/logout-complete";
const TEST_DEMO_CLIENT_SECRET = "test-oidc-demo-client-secret";
const TEST_LOGIN_ACCOUNT = `test-account-${randomUUID()}`;
const TEST_LOGIN_PASSWORD = `test-password-${randomUUID()}`;
const TEST_WRONG_LOGIN_PASSWORD = "";
const PROD_KEY_SECRET = "prod-oidc-key-secret-0123456789abcdef";
const PROD_ARTIFACT_SECRET = "prod-oidc-artifact-secret-0123456789abcd";
const PROD_CSRF_SECRET = "prod-oidc-csrf-secret-0123456789abcdef";

class FakeEmailSender implements EmailSender {
  readonly sentVerifications: SendVerificationCodeInput[] = [];

  async sendVerificationCode(input: SendVerificationCodeInput): Promise<void> {
    this.sentVerifications.push(input);
  }

  latestCode(interactionUid: string, to: string): string | undefined {
    for (let index = this.sentVerifications.length - 1; index >= 0; index -= 1) {
      const candidate = this.sentVerifications[index];
      if (!candidate) {
        continue;
      }
      if (candidate.interactionUid === interactionUid && candidate.to === to) {
        return candidate.code;
      }
    }
    return undefined;
  }
}

function extractInteractionUid(interactionLocation: string) {
  const match = interactionLocation.match(/^\/interaction\/([^/?#]+)/);
  assert.ok(match?.[1]);
  return decodeURIComponent(match[1]);
}

function extractCsrf(html: string) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match?.[1]);
  return match[1];
}

function extractConsentAction(html: string) {
  const match = html.match(/action="([^"]*\/consent)"/);
  assert.ok(match?.[1]);
  return match[1];
}

function extractFormAction(html: string) {
  const match = html.match(/<form[^>]+action="([^"]+)"/i);
  return match?.[1];
}

function extractHiddenFormInputs(html: string) {
  const inputs: Record<string, string> = {};
  const tags = html.match(/<input[^>]*type="hidden"[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = tag.match(/name="([^"]+)"/i)?.[1];
    if (!name) {
      continue;
    }
    inputs[name] = tag.match(/value="([^"]*)"/i)?.[1] ?? "";
  }
  return inputs;
}

function getSetCookieValue(response: request.Response, name: string): string | undefined {
  const cookies = response.headers["set-cookie"] as string[] | undefined;
  if (!cookies) {
    return undefined;
  }
  const prefix = `${name}=`;
  for (const header of cookies) {
    if (!header.startsWith(prefix)) {
      continue;
    }
    const end = header.indexOf(";");
    return header.slice(prefix.length, end >= 0 ? end : undefined);
  }
  return undefined;
}

function assertNoApplicationSecurityHeaders(response: request.Response) {
  assert.equal(response.headers["content-security-policy"], undefined);
  assert.equal(response.headers["x-frame-options"], undefined);
  assert.equal(response.headers["referrer-policy"], undefined);
  assert.equal(response.headers["x-content-type-options"], undefined);
}

function tamperToken(token: string) {
  if (token.length === 0) {
    return token;
  }
  const suffix = token.endsWith("a") ? "b" : "a";
  return `${token.slice(0, -1)}${suffix}`;
}

function decodeJwtPayload(token: string) {
  const [, payload] = token.split(".");
  assert.equal(typeof payload, "string");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function normalizeActionPath(action: string) {
  if (/^https?:\/\//.test(action)) {
    const url = new URL(action);
    return `${url.pathname}${url.search}`;
  }
  return action;
}

function withHeaders(testRequest: request.Test, headers?: Record<string, string>) {
  if (!headers) {
    return testRequest;
  }
  for (const [name, value] of Object.entries(headers)) {
    testRequest.set(name, value);
  }
  return testRequest;
}

async function createTestApp(overrides: NodeJS.ProcessEnv = {}) {
  const emailSender = new FakeEmailSender();
  const clientsConfigPath =
    overrides["OIDC_CLIENTS_CONFIG_PATH"] ?? (await writeTestClientsConfig({ autoConsent: true }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: "test",
    AUTH_PROVIDER: "mock",
    OIDC_COOKIE_SECURE: "false",
    OIDC_ISSUER: "http://127.0.0.1:3003",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_CLIENTS_CONFIG_PATH: clientsConfigPath,
    ...overrides
  };
  const appWithState = await createOidcApp(env, { emailSender });
  return {
    ...appWithState,
    emailSender
  };
}

function createProductionConfigEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    APP_ENV: "production",
    AUTH_PROVIDER: "cqut",
    OIDC_ISSUER: "https://auth.example.com",
    OIDC_CLIENTS_CONFIG_PATH: "/app/config/oidc-clients.json",
    OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
    OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
    OIDC_COOKIE_KEYS: "prod-oidc-cookie-key-a-0123456789,prod-oidc-cookie-key-b-0123456789",
    OIDC_CSRF_SIGNING_SECRET: PROD_CSRF_SECRET,
    RESEND_API_KEY: "test-resend-api-key",
    OIDC_EMAIL_FROM: "CQUT Auth <no-reply@auth-cqut.ciallichannel.com>",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
    DATABASE_URL: "postgres://127.0.0.1:5432/oidc",
    REDIS_URL: "redis://127.0.0.1:6379",
    OIDC_ALLOW_IN_MEMORY_STORE: "false",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "true",
    ...overrides
  };
  return env;
}

async function writeTestClientsConfig(
  patch: Partial<{
    clientSecretDigest: string | undefined;
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    autoConsent: boolean;
    status: "active" | "disabled";
  }> = {}
) {
  const directory = mkdtempSync(join(tmpdir(), "oidc-clients-"));
  const configPath = join(directory, "oidc-clients.json");
  const clientSecretDigest =
    patch.clientSecretDigest ?? (await createClientSecretDigest(TEST_DEMO_CLIENT_SECRET));
  const payload = {
    clients: [
      {
        clientId: "demo-site",
        clientSecretDigest,
        redirectUris: patch.redirectUris ?? [TEST_REDIRECT_URI],
        postLogoutRedirectUris: patch.postLogoutRedirectUris ?? [TEST_POST_LOGOUT_REDIRECT_URI],
        autoConsent: patch.autoConsent ?? false,
        status: patch.status ?? "active"
      }
    ]
  };
  writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return configPath;
}

async function followToRedirectUriOrigin(agent: any, response: request.Response, redirectUri: string) {
  const expectedOrigin = new URL(redirectUri).origin;
  let current = response;
  let hops = 0;
  while (current.status >= 300 && current.status < 400) {
    hops += 1;
    assert.ok(hops <= 20, "too many redirect hops");
    const location = current.headers["location"];
    assert.ok(location);
    if (/^https?:\/\//.test(location)) {
      const url = new URL(location);
      if (url.origin === expectedOrigin) {
        return location;
      }
      current = await agent.get(`${url.pathname}${url.search}`);
      continue;
    }
    current = await agent.get(location);
  }
  throw new Error("expected external redirect");
}

async function runAuthorizationFlow(agent: any, emailSender: FakeEmailSender, state = "state-1") {
  const { response, codeVerifier } = await authorizeThroughProfile(
    agent,
    emailSender,
    state,
    "openid profile email student offline_access"
  );
  const externalRedirect = await followToRedirectUriOrigin(agent, response, TEST_REDIRECT_URI);
  const callbackUrl = new URL(externalRedirect);
  assert.equal(callbackUrl.origin + callbackUrl.pathname, TEST_REDIRECT_URI);
  assert.equal(callbackUrl.searchParams.get("state"), state);
  const code = callbackUrl.searchParams.get("code");
  assert.ok(code);

  return {
    code: code as string,
    codeVerifier
  };
}

async function disableDemoAutoConsent(state: { store: { upsertOidcClient: (client: any) => Promise<unknown> } }) {
  await upsertDemoClient(state);
}

async function upsertDemoClient(
  state: { store: { upsertOidcClient: (client: any) => Promise<unknown> } },
  patch: Partial<{
    clientSecretDigest: string | undefined;
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    status: "active" | "disabled";
    autoConsent: boolean;
  }> = {}
) {
  const now = new Date().toISOString();
  const clientSecretDigest =
    patch.clientSecretDigest ?? (await createClientSecretDigest(TEST_DEMO_CLIENT_SECRET));
  await state.store.upsertOidcClient({
    clientId: "demo-site",
    clientSecretDigest,
    applicationType: "web",
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris: patch.redirectUris ?? [TEST_REDIRECT_URI],
    postLogoutRedirectUris: patch.postLogoutRedirectUris ?? [TEST_POST_LOGOUT_REDIRECT_URI],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopeWhitelist: ["openid", "profile", "email", "student", "offline_access"],
    requirePkce: true,
    autoConsent: patch.autoConsent ?? false,
    status: patch.status ?? "active",
    createdAt: now,
    updatedAt: now
  });
}

async function upsertPublicNoneClient(
  state: { store: { upsertOidcClient: (client: any) => Promise<unknown> } },
  clientId: string
) {
  const now = new Date().toISOString();
  await state.store.upsertOidcClient({
    clientId,
    clientSecretDigest: undefined,
    applicationType: "native",
    tokenEndpointAuthMethod: "none",
    redirectUris: [TEST_REDIRECT_URI],
    postLogoutRedirectUris: [TEST_POST_LOGOUT_REDIRECT_URI],
    grantTypes: ["refresh_token"],
    responseTypes: ["code"],
    scopeWhitelist: ["openid", "profile", "email", "student", "offline_access"],
    requirePkce: true,
    autoConsent: false,
    status: "active",
    createdAt: now,
    updatedAt: now
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 150
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timeout waiting for condition");
}

async function followToConsentPage(agent: any, response: request.Response) {
  let current = response;
  let hops = 0;
  while (current.status >= 300 && current.status < 400) {
    hops += 1;
    assert.ok(hops <= 20, "too many redirect hops before consent page");
    const location = current.headers["location"];
    assert.ok(location);
    if (/^https?:\/\//.test(location)) {
      const url = new URL(location);
      current = await agent.get(`${url.pathname}${url.search}`);
      continue;
    }
    current = await agent.get(location);
  }
  assert.equal(current.status, 200);
  assert.match(current.text, /确认授权请求/);
  return current.text;
}

async function authorizeThroughProfile(
  agent: any,
  emailSender: FakeEmailSender,
  state: string,
  scope = "openid profile"
) {
  const verifier = "manual-verifier-1234567890-manual-verifier-1234567890";
  const challenge = sha256Base64Url(verifier);
  const authorize = await agent.get("/auth").query({
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope,
    prompt: "consent",
    state,
    nonce: "manual-nonce",
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  assert.ok(authorize.status === 302 || authorize.status === 303);
  assert.match(authorize.headers["location"] as string, /^\/interaction\//);

  const interactionLocation = authorize.headers["location"] as string;
  const loginPage = await agent.get(interactionLocation);
  assert.equal(loginPage.status, 200);
  const loginCsrf = extractCsrf(loginPage.text);
  const login = await agent
    .post(`${interactionLocation}/login`)
    .type("form")
    .send({
      csrf: loginCsrf,
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD
    });
  assert.equal(login.status, 302);
  assert.match(login.headers["location"] as string, /\/interaction\/.+\/profile/);

  const profileLocation = login.headers["location"] as string;
  const interactionUid = extractInteractionUid(interactionLocation);
  const profilePage = await agent.get(profileLocation);
  assert.equal(profilePage.status, 200);
  const profileCsrf = extractCsrf(profilePage.text);
  const sendCode = await agent
    .post(profileLocation)
    .type("form")
    .send({
      csrf: profileCsrf,
      action: "send_code",
      email: "demo@example.com"
    });
  assert.equal(sendCode.status, 200);
  const verifyCsrf = extractCsrf(sendCode.text);
  const sentCode = emailSender.latestCode(interactionUid, "demo@example.com");
  assert.equal(typeof sentCode, "string");
  const profile = await agent
    .post(profileLocation)
    .type("form")
    .send({
      csrf: verifyCsrf,
      action: "verify_code",
      code: sentCode
    });
  return { response: profile, codeVerifier: verifier, profileLocation, interactionUid };
}

async function runAuthorizationToConsent(
  agent: any,
  emailSender: FakeEmailSender,
  state: string,
  scope = "openid profile"
) {
  const { response, codeVerifier } = await authorizeThroughProfile(agent, emailSender, state, scope);
  const consentPageHtml = await followToConsentPage(agent, response);
  const consentCsrf = extractCsrf(consentPageHtml);
  const consentAction = extractConsentAction(consentPageHtml);
  return { consentAction, consentCsrf, codeVerifier };
}

async function startEmailVerification(
  agent: any,
  emailSender: FakeEmailSender,
  state: string,
  email = "demo@example.com"
) {
  const { interactionUid, profileLocation, sendCode } = await sendEmailVerificationCode(
    agent,
    state,
    email
  );
  assert.equal(sendCode.status, 200);
  const code = emailSender.latestCode(interactionUid, email);
  assert.equal(typeof code, "string");
  return {
    profileLocation,
    interactionUid,
    code: code as string,
    sendCode
  };
}

async function sendEmailVerificationCode(
  agent: any,
  state: string,
  email: string,
  headers?: Record<string, string>
) {
  const { interactionLocation, loginPage } = await openLoginInteraction(agent, state, headers);
  const interactionUid = extractInteractionUid(interactionLocation);
  const loginCsrf = extractCsrf(loginPage.text);
  const login = await withHeaders(agent.post(`${interactionLocation}/login`), headers).type("form").send({
    csrf: loginCsrf,
    account: TEST_LOGIN_ACCOUNT,
    password: TEST_LOGIN_PASSWORD
  });
  assert.equal(login.status, 302);
  assert.match(login.headers["location"] as string, /\/interaction\/.+\/profile/);
  const profileLocation = login.headers["location"] as string;
  const profilePage = await withHeaders(agent.get(profileLocation), headers);
  assert.equal(profilePage.status, 200);
  const profileCsrf = extractCsrf(profilePage.text);
  const sendCode = await withHeaders(agent.post(profileLocation), headers).type("form").send({
    csrf: profileCsrf,
    action: "send_code",
    email
  });
  return {
    interactionUid,
    profileLocation,
    sendCode
  };
}

async function openLoginInteraction(agent: any, state = "login-state-1", headers?: Record<string, string>) {
  const authorize = await withHeaders(agent.get("/auth"), headers).query({
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile",
    prompt: "consent",
    state,
    nonce: "nonce-login-1",
    code_challenge: sha256Base64Url("login-verifier-login-verifier-login-verifier"),
    code_challenge_method: "S256"
  });
  assert.ok(authorize.status === 302 || authorize.status === 303);
  const interactionLocation = authorize.headers["location"] as string;
  const loginPage = await withHeaders(agent.get(interactionLocation), headers);
  assert.equal(loginPage.status, 200);
  return {
    interactionLocation,
    loginPage
  };
}

function assertAuthErrorRedirect(location: string) {
  const redirect = new URL(location);
  const hashParams = new URLSearchParams(redirect.hash.startsWith("#") ? redirect.hash.slice(1) : "");
  const code = redirect.searchParams.get("code") ?? hashParams.get("code");
  const error = redirect.searchParams.get("error") ?? hashParams.get("error");
  assert.equal(redirect.origin + redirect.pathname, TEST_REDIRECT_URI);
  assert.equal(code, null);
  assert.equal(typeof error, "string");
}

async function assertAuthorizationRequestRejected(agent: any, query: Record<string, string>) {
  const authorize = await agent.get("/auth").query(query);
  if (authorize.status >= 300 && authorize.status < 400) {
    const location = authorize.headers["location"] as string | undefined;
    assert.ok(location);
    if (/^https?:\/\//.test(location)) {
      assertAuthErrorRedirect(location);
      return;
    }
    assert.doesNotMatch(location, /^\/interaction\//);
    return;
  }
  assert.ok(authorize.status >= 400);
}

test("discovery and jwks endpoints are available", async () => {
  const { app, state } = await createTestApp();
  const http = request(app);

  const discovery = await http.get("/.well-known/openid-configuration");
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.issuer, "http://127.0.0.1:3003");
  assert.equal(new URL(discovery.body.authorization_endpoint).pathname, "/auth");
  assert.equal(new URL(discovery.body.userinfo_endpoint).pathname, "/userinfo");
  assert.deepEqual(discovery.body.response_types_supported, ["code"]);
  assert.deepEqual(discovery.body.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(discovery.body.subject_types_supported, ["public"]);
  assert.deepEqual(discovery.body.code_challenge_methods_supported, ["S256"]);
  assert.equal(Object.hasOwn(discovery.body as object, "registration_endpoint"), false);
  assert.equal(Object.hasOwn(discovery.body as object, "introspection_endpoint"), false);
  assert.equal(Object.hasOwn(discovery.body as object, "revocation_endpoint"), false);
  assert.equal(Object.hasOwn(discovery.body as object, "device_authorization_endpoint"), false);

  const jwks = await http.get("/jwks");
  assert.equal(jwks.status, 200);
  assert.equal(Array.isArray(jwks.body.keys), true);
  assert.equal(jwks.body.keys[0]?.alg, "RS256");

  await state.store.close();
});

test("disabled OIDC feature endpoints reject requests", async () => {
  const { app, state } = await createTestApp();
  const http = request(app);

  const registration = await http.get("/reg");
  assert.ok(registration.status >= 400);

  const introspection = await http
    .post("/token/introspection")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ token: "test-token" });
  assert.ok(introspection.status >= 400);

  const revocation = await http
    .post("/token/revocation")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ token: "test-token" });
  assert.ok(revocation.status >= 400);

  const device = await http
    .post("/device/auth")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ scope: "openid" });
  assert.ok(device.status >= 400);

  await state.store.close();
});

test("authorization endpoint only accepts response_type=code", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);

  await assertAuthorizationRequestRejected(agent, {
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "token",
    scope: "openid profile",
    state: "invalid-response-type",
    nonce: "invalid-response-type-nonce",
    code_challenge: sha256Base64Url("invalid-response-type-verifier"),
    code_challenge_method: "S256"
  });

  await state.store.close();
});

test("authorization endpoint requires PKCE S256", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);

  await assertAuthorizationRequestRejected(agent, {
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile",
    state: "missing-pkce",
    nonce: "missing-pkce-nonce"
  });

  await assertAuthorizationRequestRejected(agent, {
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile",
    state: "plain-pkce-method",
    nonce: "plain-pkce-method-nonce",
    code_challenge: "plain-challenge",
    code_challenge_method: "plain"
  });

  await state.store.close();
});

test("application leaves security headers to reverse proxy", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { loginPage } = await openLoginInteraction(agent, "security-headers-state");
  assertNoApplicationSecurityHeaders(loginPage);

  const errorPage = await request(app).get("/auth");
  assert.ok(errorPage.status >= 400);
  assertNoApplicationSecurityHeaders(errorPage);

  const logoutPage = await agent.get("/session/end").query({
    client_id: "demo-site"
  });
  assert.equal(logoutPage.status, 200);
  assertNoApplicationSecurityHeaders(logoutPage);
  await state.store.close();
});

test("interaction page sets HttpOnly csrf nonce cookie with SameSite Lax", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { loginPage } = await openLoginInteraction(agent, "csrf-cookie-attrs-state");
  assert.equal(loginPage.status, 200);
  extractCsrf(loginPage.text);

  const nonceSetCookie = (loginPage.headers["set-cookie"] as string[] | undefined)?.find((cookie) =>
    cookie.startsWith("op_csrf_nonce=")
  );
  assert.ok(nonceSetCookie);
  assert.match(nonceSetCookie as string, /;\s*HttpOnly/i);
  assert.match(nonceSetCookie as string, /;\s*SameSite=Lax/i);
  assert.doesNotMatch(nonceSetCookie as string, /;\s*Secure/i);

  await state.store.close();
});

test("csrf rejects tampered token", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(agent, "csrf-tamper-state");
  const csrf = extractCsrf(loginPage.text);

  const response = await agent.post(`${interactionLocation}/login`).type("form").send({
    csrf: tamperToken(csrf),
    account: TEST_LOGIN_ACCOUNT,
    password: TEST_LOGIN_PASSWORD
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /CSRF 校验失败，请刷新后重试/);

  await state.store.close();
});

test("csrf rejects token reuse across interaction uid", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(agent, "csrf-uid-a");
  const csrf = extractCsrf(loginPage.text);
  assert.ok(getSetCookieValue(loginPage, "op_csrf_nonce"));

  const secondAuthorize = await agent.get("/auth").query({
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile",
    prompt: "consent",
    state: "csrf-uid-b",
    nonce: "csrf-uid-b-nonce",
    code_challenge: sha256Base64Url("csrf-uid-b-verifier-csrf-uid-b-verifier"),
    code_challenge_method: "S256"
  });
  assert.ok(secondAuthorize.status === 302 || secondAuthorize.status === 303);
  const secondInteractionLocation = secondAuthorize.headers["location"] as string;
  assert.match(secondInteractionLocation, /^\/interaction\//);
  assert.notEqual(secondInteractionLocation, interactionLocation);

  const response = await agent.post(`${secondInteractionLocation}/login`).type("form").send({
    csrf,
    account: TEST_LOGIN_ACCOUNT,
    password: TEST_LOGIN_PASSWORD
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /CSRF 校验失败，请刷新后重试/);

  await state.store.close();
});

test("csrf rejects missing or mismatched nonce cookie", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(agent, "csrf-nonce-state");
  const csrf = extractCsrf(loginPage.text);

  const withoutCookie = await request(app).post(`${interactionLocation}/login`).type("form").send({
    csrf,
    account: TEST_LOGIN_ACCOUNT,
    password: TEST_LOGIN_PASSWORD
  });
  assert.equal(withoutCookie.status, 400);

  const withWrongCookie = await request(app)
    .post(`${interactionLocation}/login`)
    .set("Cookie", "op_csrf_nonce=invalid")
    .type("form")
    .send({
      csrf,
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD
    });
  assert.equal(withWrongCookie.status, 400);
  assert.match(withWrongCookie.text, /CSRF 校验失败，请刷新后重试/);

  await state.store.close();
});

test("csrf rejects expired token", async () => {
  const { app, state } = await createTestApp({
    OIDC_CSRF_TOKEN_TTL_SECONDS: "1"
  });
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(agent, "csrf-expired-state");
  const csrf = extractCsrf(loginPage.text);

  await new Promise((resolve) => setTimeout(resolve, 2100));

  const response = await agent.post(`${interactionLocation}/login`).type("form").send({
    csrf,
    account: TEST_LOGIN_ACCOUNT,
    password: TEST_LOGIN_PASSWORD
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /CSRF 校验失败，请刷新后重试/);

  await state.store.close();
});

test("client secret digest uses scrypt and rejects non-scrypt legacy format", async () => {
  const digest = await createClientSecretDigest(TEST_DEMO_CLIENT_SECRET);
  assert.match(digest, /^scrypt\$/);
  assert.equal(await verifyClientSecretDigest(TEST_DEMO_CLIENT_SECRET, digest), true);
  assert.equal(await verifyClientSecretDigest("wrong-secret", digest), false);
  assert.equal(await verifyClientSecretDigest(TEST_DEMO_CLIENT_SECRET, "legacy-sha256-digest"), false);
});

test("encryptJson uses versioned scrypt envelope and rejects tampered version", async () => {
  const ciphertext = await encryptJson(TEST_DEMO_CLIENT_SECRET, {
    value: "top-secret"
  });
  assert.match(ciphertext, /^v2\$scrypt\$/);
  const parsed = await decryptJson<{ value: string }>(TEST_DEMO_CLIENT_SECRET, ciphertext);
  assert.equal(parsed.value, "top-secret");

  const tampered = ciphertext.replace(/^v2\$scrypt\$/, "v1$scrypt$");
  await assert.rejects(
    () => decryptJson(TEST_DEMO_CLIENT_SECRET, tampered),
    /unsupported ciphertext version/
  );
  await assert.rejects(() => decryptJson("wrong-secret", ciphertext));
});

test("seeded demo client is confidential web client", async () => {
  const { state } = await createTestApp();
  const client = await state.store.findOidcClient("demo-site");
  assert.ok(client);
  assert.equal(client?.applicationType, "web");
  assert.equal(client?.tokenEndpointAuthMethod, "client_secret_basic");
  assert.equal(typeof client?.clientSecretDigest, "string");
  assert.equal(
    await verifyClientSecretDigest(TEST_DEMO_CLIENT_SECRET, client?.clientSecretDigest as string),
    true
  );
  assert.equal(client?.autoConsent, true);
  await state.store.close();
});

test("client disable takes effect immediately without restart", async () => {
  const { app, state } = await createTestApp();
  await upsertDemoClient(state, { status: "disabled" });
  const response = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-disabled-client" });
  assert.ok(response.status === 400 || response.status === 401);
  assert.equal(response.body.error, "invalid_client");
  await state.store.close();
});

test("redirect uri updates take effect immediately without restart", async () => {
  const { app, state } = await createTestApp();
  const updatedRedirectUri = "http://localhost:3002/demo/callback-updated";
  await upsertDemoClient(state, {
    redirectUris: [updatedRedirectUri]
  });

  await assertAuthorizationRequestRejected(request.agent(app), {
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile",
    state: "stale-redirect-uri",
    nonce: "stale-redirect-uri-nonce",
    code_challenge: sha256Base64Url("stale-redirect-uri-verifier-stale-redirect-uri-verifier"),
    code_challenge_method: "S256"
  });

  const authorize = await request(app).get("/auth").query({
    client_id: "demo-site",
    redirect_uri: updatedRedirectUri,
    response_type: "code",
    scope: "openid profile",
    prompt: "consent",
    state: "updated-redirect-uri",
    nonce: "updated-redirect-uri-nonce",
    code_challenge: sha256Base64Url("updated-redirect-uri-verifier-updated-redirect-uri-verifier"),
    code_challenge_method: "S256"
  });
  assert.ok(authorize.status === 302 || authorize.status === 303);
  assert.match(authorize.headers["location"] as string, /^\/interaction\//);
  await state.store.close();
});

test("client secret rotation takes effect immediately without restart", async () => {
  const { app, state } = await createTestApp();
  const beforeRotation = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-before-rotation" });
  assert.notEqual(beforeRotation.body.error, "invalid_client");

  const rotatedSecret = `rotated-${Date.now()}-secret`;
  await upsertDemoClient(state, {
    clientSecretDigest: await createClientSecretDigest(rotatedSecret)
  });

  const oldSecret = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-old-secret" });
  assert.ok(oldSecret.status === 400 || oldSecret.status === 401);
  assert.equal(oldSecret.body.error, "invalid_client");

  const newSecret = await request(app)
    .post("/token")
    .auth("demo-site", rotatedSecret, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-new-secret" });
  assert.notEqual(newSecret.body.error, "invalid_client");
  await state.store.close();
});

test("signing key refresh updates jwks within configured interval", async () => {
  const { app, state } = await createTestApp({
    OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS: "1"
  });
  const initialJwks = await request(app).get("/jwks");
  assert.equal(initialJwks.status, 200);
  const initialKids = new Set((initialJwks.body.keys as Array<{ kid?: string }>).map((key) => key.kid).filter(Boolean));
  const addedKey = await generateSigningKey(state.store);

  await waitFor(async () => {
    const jwks = await request(app).get("/jwks");
    const kids = (jwks.body.keys as Array<{ kid?: string }>).map((key) => key.kid);
    return kids.includes(addedKey.kid);
  });

  await state.store.upsertSigningKey({
    ...addedKey,
    status: "retired",
    retiredAt: new Date().toISOString()
  });

  await waitFor(async () => {
    const jwks = await request(app).get("/jwks");
    const kids = (jwks.body.keys as Array<{ kid?: string }>).map((key) => key.kid);
    const keepsExisting = [...initialKids].every((kid) => kids.includes(kid));
    return keepsExisting && !kids.includes(addedKey.kid);
  });

  await state.store.close();
});

test("authorization code flow, userinfo, refresh rotation, and session reuse work", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);

  const { code, codeVerifier } = await runAuthorizationFlow(agent, emailSender, "state-1");

  const token = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: codeVerifier
    });
  assert.equal(token.status, 200);
  assert.equal(typeof token.body.id_token, "string");
  assert.equal(typeof token.body.access_token, "string");
  assert.equal(typeof token.body.refresh_token, "string");

  const userinfo = await request(app)
    .get("/userinfo")
    .set("Authorization", `Bearer ${token.body.access_token as string}`);
  assert.equal(userinfo.status, 200);
  assert.equal(userinfo.body.sub, userinfo.body.sub);
  assert.equal(userinfo.body.email, "demo@example.com");
  assert.equal(userinfo.body.email_verified, true);
  assert.equal(userinfo.body.status, "active_student");
  assert.equal(Object.hasOwn(userinfo.body as object, "school"), false);
  assert.equal(Object.hasOwn(userinfo.body as object, "student_status"), false);

  const secondAuthorize = await agent.get("/auth").query({
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email student offline_access",
    prompt: "none",
    state: "state-2",
    nonce: "nonce-2",
    code_challenge: sha256Base64Url("another-verifier-another-verifier-another-verifier"),
    code_challenge_method: "S256"
  });
  assert.ok(secondAuthorize.status === 302 || secondAuthorize.status === 303);
  const secondRedirect = await followToRedirectUriOrigin(agent, secondAuthorize, TEST_REDIRECT_URI);
  assert.match(secondRedirect, /^http:\/\/localhost:3002\/demo\/callback\?/);

  const rotated = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token as string
    });
  assert.equal(rotated.status, 200);
  assert.equal(typeof rotated.body.refresh_token, "string");
  assert.notEqual(rotated.body.refresh_token, token.body.refresh_token);

  const reuse = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token as string
    });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, "invalid_grant");

  await state.store.close();
});

test("unverified email stays in profile but is omitted from oidc claims when verification is disabled", async () => {
  const { app, state } = await createTestApp({
    OIDC_EMAIL_VERIFICATION_ENABLED: "false"
  });
  const agent = request.agent(app);
  const verifier = "unverified-email-verifier-1234567890-unverified-email";
  const authorize = await agent.get("/auth").query({
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email",
    prompt: "consent",
    state: "state-unverified-email",
    nonce: "nonce-unverified-email",
    code_challenge: sha256Base64Url(verifier),
    code_challenge_method: "S256"
  });
  assert.ok(authorize.status === 302 || authorize.status === 303);
  const interactionLocation = authorize.headers["location"] as string;

  const loginPage = await agent.get(interactionLocation);
  assert.equal(loginPage.status, 200);
  const loginCsrf = extractCsrf(loginPage.text);
  const login = await agent.post(`${interactionLocation}/login`).type("form").send({
    csrf: loginCsrf,
    account: TEST_LOGIN_ACCOUNT,
    password: TEST_LOGIN_PASSWORD
  });
  assert.equal(login.status, 302);
  assert.match(login.headers["location"] as string, /\/interaction\/.+\/profile/);

  const profileLocation = login.headers["location"] as string;
  const profilePage = await agent.get(profileLocation);
  assert.equal(profilePage.status, 200);
  const profileCsrf = extractCsrf(profilePage.text);
  const chosenEmail = "victim@example.com";
  const submitProfile = await agent.post(profileLocation).type("form").send({
    csrf: profileCsrf,
    email: chosenEmail
  });
  const redirectLocation = await followToRedirectUriOrigin(agent, submitProfile, TEST_REDIRECT_URI);
  const redirectUrl = new URL(redirectLocation);
  const code = redirectUrl.searchParams.get("code");
  assert.equal(typeof code, "string");

  const token = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: verifier
    });
  assert.equal(token.status, 200);
  assert.equal(typeof token.body.id_token, "string");
  assert.equal(typeof token.body.access_token, "string");
  const idTokenClaims = decodeJwtPayload(token.body.id_token as string);

  const userinfo = await request(app)
    .get("/userinfo")
    .set("Authorization", `Bearer ${token.body.access_token as string}`);
  assert.equal(userinfo.status, 200);
  assert.equal(Object.hasOwn(userinfo.body as object, "email"), false);
  assert.equal(Object.hasOwn(userinfo.body as object, "email_verified"), false);
  assert.equal(Object.hasOwn(idTokenClaims, "email"), false);
  assert.equal(Object.hasOwn(idTokenClaims, "email_verified"), false);

  const principal = await state.store.findPrincipalBySubjectId(userinfo.body.sub as string);
  assert.ok(principal);
  assert.equal(principal.email, chosenEmail);
  assert.equal(principal.emailVerified, false);

  await state.store.close();
});

test("rp initiated logout redirects to post_logout_redirect_uri", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);

  const logoutPage = await agent.get("/session/end").query({
    client_id: "demo-site",
    post_logout_redirect_uri: TEST_POST_LOGOUT_REDIRECT_URI,
    state: "logout-state-1"
  });
  assert.equal(logoutPage.status, 200);
  const formAction = extractFormAction(logoutPage.text);
  assert.equal(typeof formAction, "string");

  const hiddenFields = extractHiddenFormInputs(logoutPage.text);
  const submit = await agent
    .post(normalizeActionPath(formAction as string))
    .type("form")
    .send({
      ...hiddenFields,
      logout: "yes"
    });
  const externalRedirect = await followToRedirectUriOrigin(
    agent,
    submit,
    TEST_POST_LOGOUT_REDIRECT_URI
  );
  const redirect = new URL(externalRedirect);
  assert.equal(redirect.origin + redirect.pathname, TEST_POST_LOGOUT_REDIRECT_URI);
  assert.equal(redirect.searchParams.get("state"), "logout-state-1");

  await state.store.close();
});

test("rp initiated logout shows success page when no redirect uri is provided", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);

  const logoutPage = await agent.get("/session/end").query({
    client_id: "demo-site"
  });
  assert.equal(logoutPage.status, 200);
  const formAction = extractFormAction(logoutPage.text);
  assert.equal(typeof formAction, "string");

  const hiddenFields = extractHiddenFormInputs(logoutPage.text);
  const submit = await agent
    .post(normalizeActionPath(formAction as string))
    .type("form")
    .send({
      ...hiddenFields,
      logout: "yes"
    });
  let successResponse = submit;
  if (submit.status >= 300 && submit.status < 400) {
    const location = submit.headers["location"];
    assert.ok(location);
    if (/^https?:\/\//.test(location)) {
      const url = new URL(location);
      successResponse = await agent.get(`${url.pathname}${url.search}`);
    } else {
      successResponse = await agent.get(location);
    }
  }
  assert.equal(successResponse.status, 200);
  assert.match(successResponse.text, /你已退出登录。/);

  await state.store.close();
});

test("rp initiated logout rejects unregistered post_logout_redirect_uri", async () => {
  const { app, state } = await createTestApp();
  const response = await request(app).get("/session/end").query({
    client_id: "demo-site",
    post_logout_redirect_uri: "http://localhost:3002/demo"
  });
  assert.equal(response.status, 400);
  await state.store.close();
});

test("non-whitelisted clients require explicit consent approval", async () => {
  const { app, state, emailSender } = await createTestApp();
  await disableDemoAutoConsent(state);
  const agent = request.agent(app);
  const { consentAction, consentCsrf } = await runAuthorizationToConsent(
    agent,
    emailSender,
    "manual-state-allow"
  );

  const approved = await agent
    .post(consentAction)
    .type("form")
    .send({ csrf: consentCsrf, action: "approve" });
  const callbackRedirect = await followToRedirectUriOrigin(agent, approved, TEST_REDIRECT_URI);
  const callbackUrl = new URL(callbackRedirect);
  assert.equal(callbackUrl.origin + callbackUrl.pathname, TEST_REDIRECT_URI);
  assert.equal(callbackUrl.searchParams.get("state"), "manual-state-allow");
  assert.equal(typeof callbackUrl.searchParams.get("code"), "string");

  await state.store.close();
});

test("consent denial returns access_denied to client redirect uri", async () => {
  const { app, state, emailSender } = await createTestApp();
  await disableDemoAutoConsent(state);
  const agent = request.agent(app);
  const { consentAction, consentCsrf } = await runAuthorizationToConsent(
    agent,
    emailSender,
    "manual-state-deny"
  );

  const denied = await agent
    .post(consentAction)
    .type("form")
    .send({ csrf: consentCsrf, action: "deny" });
  const denyRedirect = await followToRedirectUriOrigin(agent, denied, TEST_REDIRECT_URI);
  const denyUrl = new URL(denyRedirect);
  assert.equal(denyUrl.origin + denyUrl.pathname, TEST_REDIRECT_URI);
  assert.equal(denyUrl.searchParams.get("state"), "manual-state-deny");
  assert.equal(denyUrl.searchParams.get("error"), "access_denied");
  assert.equal(denyUrl.searchParams.get("code"), null);

  await state.store.close();
});

test("prompt=none does not silently grant newly requested scopes", async () => {
  const { app, state, emailSender } = await createTestApp();
  await disableDemoAutoConsent(state);
  const agent = request.agent(app);
  const { consentAction, consentCsrf } = await runAuthorizationToConsent(
    agent,
    emailSender,
    "manual-state-initial",
    "openid profile"
  );

  await agent
    .post(consentAction)
    .type("form")
    .send({ csrf: consentCsrf, action: "approve" });

  const secondAuthorize = await agent.get("/auth").query({
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email",
    prompt: "none",
    state: "manual-state-none",
    nonce: "manual-nonce-2",
    code_challenge: sha256Base64Url("manual-verifier-second-manual-verifier-second"),
    code_challenge_method: "S256"
  });
  const secondRedirect = await followToRedirectUriOrigin(agent, secondAuthorize, TEST_REDIRECT_URI);
  const secondUrl = new URL(secondRedirect);
  assert.equal(secondUrl.origin + secondUrl.pathname, TEST_REDIRECT_URI);
  assert.equal(secondUrl.searchParams.get("state"), "manual-state-none");
  assert.ok(["consent_required", "interaction_required"].includes(secondUrl.searchParams.get("error") ?? ""));
  assert.equal(secondUrl.searchParams.get("code"), null);

  await state.store.close();
});

test("interactive login failure does not expose internal error details", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(agent, "login-fail-state");
  const csrf = extractCsrf(loginPage.text);
  const login = await agent.post(`${interactionLocation}/login`).type("form").send({
    csrf,
    account: TEST_LOGIN_ACCOUNT,
    password: TEST_WRONG_LOGIN_PASSWORD
  });

  assert.equal(login.status, 401);
  assert.match(login.text, /登录失败，请检查账号或密码后重试/);
  assert.doesNotMatch(login.text, /IdentityCoreError|invalid credentials/i);
  await state.store.close();
});

test("interactive login failure rate limit blocks repeated attempts for the same account across trusted proxy ips", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_LOGIN_FAILURE_LIMIT: "2"
  });
  const agent = request.agent(app);
  const account = "rate-limit-account";

  const firstInteraction = await openLoginInteraction(agent, "login-account-limit-1", {
    "X-Forwarded-For": "198.51.100.1"
  });
  const first = await withHeaders(agent.post(`${firstInteraction.interactionLocation}/login`), {
    "X-Forwarded-For": "198.51.100.1"
  })
    .type("form")
    .send({ csrf: extractCsrf(firstInteraction.loginPage.text), account, password: TEST_WRONG_LOGIN_PASSWORD });

  const secondInteraction = await openLoginInteraction(agent, "login-account-limit-2", {
    "X-Forwarded-For": "198.51.100.2"
  });
  const second = await withHeaders(agent.post(`${secondInteraction.interactionLocation}/login`), {
    "X-Forwarded-For": "198.51.100.2"
  })
    .type("form")
    .send({ csrf: extractCsrf(secondInteraction.loginPage.text), account, password: TEST_WRONG_LOGIN_PASSWORD });

  const thirdInteraction = await openLoginInteraction(agent, "login-account-limit-3", {
    "X-Forwarded-For": "198.51.100.3"
  });
  const third = await withHeaders(agent.post(`${thirdInteraction.interactionLocation}/login`), {
    "X-Forwarded-For": "198.51.100.3"
  })
    .type("form")
    .send({ csrf: extractCsrf(thirdInteraction.loginPage.text), account, password: TEST_WRONG_LOGIN_PASSWORD });

  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(third.status, 429);
  await state.store.close();
});

test("interactive login failure rate limit blocks sprays from the same trusted proxy ip across accounts", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_LOGIN_FAILURE_LIMIT: "2"
  });
  const agent = request.agent(app);
  const headers = { "X-Forwarded-For": "198.51.100.10" };

  const firstInteraction = await openLoginInteraction(agent, "login-ip-limit-1", headers);
  const first = await withHeaders(agent.post(`${firstInteraction.interactionLocation}/login`), headers)
    .type("form")
    .send({ csrf: extractCsrf(firstInteraction.loginPage.text), account: "spray-account-a", password: TEST_WRONG_LOGIN_PASSWORD });

  const secondInteraction = await openLoginInteraction(agent, "login-ip-limit-2", headers);
  const second = await withHeaders(agent.post(`${secondInteraction.interactionLocation}/login`), headers)
    .type("form")
    .send({ csrf: extractCsrf(secondInteraction.loginPage.text), account: "spray-account-b", password: TEST_WRONG_LOGIN_PASSWORD });

  const thirdInteraction = await openLoginInteraction(agent, "login-ip-limit-3", headers);
  const third = await withHeaders(agent.post(`${thirdInteraction.interactionLocation}/login`), headers)
    .type("form")
    .send({ csrf: extractCsrf(thirdInteraction.loginPage.text), account: "spray-account-c", password: TEST_WRONG_LOGIN_PASSWORD });

  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(third.status, 429);
  await state.store.close();
});

test("interactive login failure rate limit blocks repeated attempts for the same account and trusted proxy ip", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_LOGIN_FAILURE_LIMIT: "1"
  });
  const agent = request.agent(app);
  const headers = { "X-Forwarded-For": "198.51.100.20" };

  const firstInteraction = await openLoginInteraction(agent, "login-account-ip-limit-1", headers);
  const first = await withHeaders(agent.post(`${firstInteraction.interactionLocation}/login`), headers)
    .type("form")
    .send({ csrf: extractCsrf(firstInteraction.loginPage.text), account: "combo-account", password: TEST_WRONG_LOGIN_PASSWORD });

  const secondInteraction = await openLoginInteraction(agent, "login-account-ip-limit-2", headers);
  const second = await withHeaders(agent.post(`${secondInteraction.interactionLocation}/login`), headers)
    .type("form")
    .send({ csrf: extractCsrf(secondInteraction.loginPage.text), account: "combo-account", password: TEST_WRONG_LOGIN_PASSWORD });

  assert.equal(first.status, 401);
  assert.equal(second.status, 429);
  await state.store.close();
});

test("interactive login success clears account failure buckets but keeps shared ip protection", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_LOGIN_FAILURE_LIMIT: "2"
  });
  const agent = request.agent(app);
  const headers = { "X-Forwarded-For": "198.51.100.30" };

  const firstInteraction = await openLoginInteraction(agent, "login-reset-1", headers);
  const first = await withHeaders(agent.post(`${firstInteraction.interactionLocation}/login`), headers)
    .type("form")
    .send({ csrf: extractCsrf(firstInteraction.loginPage.text), account: TEST_LOGIN_ACCOUNT, password: TEST_WRONG_LOGIN_PASSWORD });

  const secondInteraction = await openLoginInteraction(agent, "login-reset-2", headers);
  const second = await withHeaders(agent.post(`${secondInteraction.interactionLocation}/login`), headers)
    .type("form")
    .send({ csrf: extractCsrf(secondInteraction.loginPage.text), account: "other-account-before-success", password: TEST_WRONG_LOGIN_PASSWORD });

  const successInteraction = await openLoginInteraction(agent, "login-reset-3", headers);
  const success = await withHeaders(agent.post(`${successInteraction.interactionLocation}/login`), headers)
    .type("form")
    .send({ csrf: extractCsrf(successInteraction.loginPage.text), account: TEST_LOGIN_ACCOUNT, password: TEST_LOGIN_PASSWORD });

  const blockedInteraction = await openLoginInteraction(agent, "login-reset-4", headers);
  const blocked = await withHeaders(agent.post(`${blockedInteraction.interactionLocation}/login`), headers)
    .type("form")
    .send({ csrf: extractCsrf(blockedInteraction.loginPage.text), account: "other-account-after-success", password: TEST_WRONG_LOGIN_PASSWORD });

  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(success.status, 302);
  assert.equal(blocked.status, 429);
  await state.store.close();
});

test("email verification rejects wrong code after max attempts", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);
  const { profileLocation, sendCode } = await startEmailVerification(
    agent,
    emailSender,
    "email-verify-wrong-code"
  );

  let csrf = extractCsrf(sendCode.text);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const verify = await agent
      .post(profileLocation)
      .type("form")
      .send({
        csrf,
        action: "verify_code",
        code: "000000"
      });
    assert.equal(verify.status, 400);
    if (attempt < 5) {
      assert.match(verify.text, /验证码错误，还可尝试/);
      csrf = extractCsrf(verify.text);
      continue;
    }
    assert.match(verify.text, /验证码尝试次数过多，请重新发送/);
  }

  await state.store.close();
});

test("email verification expires and requires resending code", async () => {
  const { app, state, emailSender } = await createTestApp({
    OIDC_EMAIL_VERIFY_CODE_TTL_SECONDS: "1"
  });
  const agent = request.agent(app);
  const { profileLocation, code, sendCode } = await startEmailVerification(
    agent,
    emailSender,
    "email-verify-expired"
  );
  const verifyCsrf = extractCsrf(sendCode.text);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const verify = await agent
    .post(profileLocation)
    .type("form")
    .send({
      csrf: verifyCsrf,
      action: "verify_code",
      code
    });
  assert.equal(verify.status, 400);
  assert.match(verify.text, /验证码已过期，请重新发送/);
  await state.store.close();
});

test("email verification resend is blocked during cooldown window", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);
  const { profileLocation, sendCode } = await startEmailVerification(
    agent,
    emailSender,
    "email-verify-cooldown"
  );
  const resendCsrf = extractCsrf(sendCode.text);
  const resend = await agent
    .post(profileLocation)
    .type("form")
    .send({
      csrf: resendCsrf,
      action: "send_code",
      email: "demo@example.com"
    });
  assert.equal(resend.status, 429);
  assert.match(resend.text, /秒后再重试发送/);
  await state.store.close();
});

test("email verification global rate limit blocks by subjectId across interactions", async () => {
  const { app, state, emailSender } = await createTestApp({
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "10"
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(agent, "email-verify-subject-limit-first", "first@alpha.example.com");
  assert.equal(first.sendCode.status, 200);
  assert.equal(emailSender.sentVerifications.length, 1);

  const second = await sendEmailVerificationCode(agent, "email-verify-subject-limit-second", "second@beta.example.com");
  assert.equal(second.sendCode.status, 429);
  assert.equal(second.sendCode.headers["retry-after"], "600");
  assert.match(second.sendCode.text, /发送过于频繁/);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.store.close();
});

test("email verification global rate limit blocks by target email across interactions", async () => {
  const { app, state, emailSender } = await createTestApp({
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "10"
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(agent, "email-verify-email-limit-first", "victim@example.com");
  assert.equal(first.sendCode.status, 200);
  assert.equal(emailSender.sentVerifications.length, 1);

  const second = await sendEmailVerificationCode(agent, "email-verify-email-limit-second", "victim@example.com");
  assert.equal(second.sendCode.status, 429);
  assert.equal(second.sendCode.headers["retry-after"], "600");
  assert.match(second.sendCode.text, /发送过于频繁/);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.store.close();
});

test("email verification global rate limit blocks by target domain across interactions", async () => {
  const { app, state, emailSender } = await createTestApp({
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "10"
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(agent, "email-verify-domain-limit-first", "first@target.example.com");
  assert.equal(first.sendCode.status, 200);
  assert.equal(emailSender.sentVerifications.length, 1);

  const second = await sendEmailVerificationCode(agent, "email-verify-domain-limit-second", "second@target.example.com");
  assert.equal(second.sendCode.status, 429);
  assert.equal(second.sendCode.headers["retry-after"], "600");
  assert.match(second.sendCode.text, /发送过于频繁/);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.store.close();
});

test("email verification global rate limit blocks by source ip across interactions", async () => {
  const { app, state, emailSender } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "1"
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(
    agent,
    "email-verify-ip-limit-first",
    "first@ip-a.example.com",
    { "X-Forwarded-For": "198.51.100.40" }
  );
  assert.equal(first.sendCode.status, 200);
  assert.equal(emailSender.sentVerifications.length, 1);

  const second = await sendEmailVerificationCode(
    agent,
    "email-verify-ip-limit-second",
    "second@ip-b.example.com",
    { "X-Forwarded-For": "198.51.100.40" }
  );
  assert.equal(second.sendCode.status, 429);
  assert.equal(second.sendCode.headers["retry-after"], "600");
  assert.match(second.sendCode.text, /发送过于频繁/);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.store.close();
});

test("email verification trusted proxy resolution ignores spoofed leading forwarded ips", async () => {
  const { app, state, emailSender } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "1"
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(
    agent,
    "email-verify-spoofed-xff-first",
    "first@spoofed.example.com",
    { "X-Forwarded-For": "203.0.113.1, 198.51.100.50" }
  );
  const second = await sendEmailVerificationCode(
    agent,
    "email-verify-spoofed-xff-second",
    "second@spoofed.example.com",
    { "X-Forwarded-For": "203.0.113.99, 198.51.100.50" }
  );

  assert.equal(first.sendCode.status, 200);
  assert.equal(second.sendCode.status, 429);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.store.close();
});

test("OIDC error page returns generic message only", async () => {
  const { app, state } = await createTestApp();
  const response = await request(app).get("/auth");
  assert.ok(response.status >= 400);
  assert.match(response.text, /认证请求未能完成，请刷新后重试。/);
  assert.doesNotMatch(response.text, /client_id|required|invalid_request/i);
  await state.store.close();
});

test("token endpoint returns 503 when rate limiter is fail-closed and redis is unavailable", async () => {
  const { app, state } = await createTestApp({
    REDIS_URL: "redis://127.0.0.1:1",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "true"
  });
  const response = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token" });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "service_unavailable");
  await state.store.close();
});

test("token endpoint returns 503 when fail-closed mode is enabled and REDIS_URL is missing", async () => {
  const { app, state } = await createTestApp({
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "true"
  });
  const response = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token" });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "service_unavailable");
  await state.store.close();
});

test("token endpoint rate limit blocks the same none-auth client_id across trusted proxy ips", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "2",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60"
  });
  await upsertPublicNoneClient(state, "public-a");

  const first = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.61")
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-a-1", client_id: "public-a" });
  const second = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.62")
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-a-2", client_id: "public-a" });
  const third = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.63")
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-a-3", client_id: "public-a" });

  assert.notEqual(first.status, 429);
  assert.notEqual(second.status, 429);
  assert.equal(third.status, 429);
  await state.store.close();
});

test("token endpoint rate limit blocks multiple none-auth client_ids from the same trusted proxy ip", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "2",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60"
  });
  await upsertPublicNoneClient(state, "public-a");
  await upsertPublicNoneClient(state, "public-b");
  await upsertPublicNoneClient(state, "public-c");

  const first = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.70")
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-a-1", client_id: "public-a" });
  const second = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.70")
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-b-1", client_id: "public-b" });
  const third = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.70")
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-c-1", client_id: "public-c" });

  assert.notEqual(first.status, 429);
  assert.notEqual(second.status, 429);
  assert.equal(third.status, 429);
  await state.store.close();
});

test("token endpoint rate limit isolates Basic client bucket from none client bucket", async () => {
  const { app, state } = await createTestApp({
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "1",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60"
  });
  await upsertPublicNoneClient(state, "public-b");

  const first = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-basic-1" });
  const second = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-basic-2" });
  const noneClient = await request(app)
    .post("/token")
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token-none-1", client_id: "public-b" });

  assert.notEqual(first.status, 429);
  assert.equal(second.status, 429);
  assert.notEqual(noneClient.status, 429);
  await state.store.close();
});

test("token endpoint rate limit uses anonymous fallback bucket when client identity is missing", async () => {
  const { app, state } = await createTestApp({
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "1",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60"
  });

  const first = await request(app).post("/token").type("form").send({ grant_type: "refresh_token" });
  const second = await request(app).post("/token").type("form").send({ grant_type: "refresh_token" });

  assert.equal(first.status, 400);
  assert.equal(first.body.error, "invalid_request");
  assert.equal(second.status, 429);
  assert.equal(second.body.error, "rate_limited");
  await state.store.close();
});

test("token endpoint trusted proxy resolution ignores spoofed leading forwarded ips", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "1",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60"
  });

  const first = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "203.0.113.10, 198.51.100.80")
    .type("form")
    .send({ grant_type: "refresh_token" });
  const second = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "203.0.113.99, 198.51.100.80")
    .type("form")
    .send({ grant_type: "refresh_token" });

  assert.equal(first.status, 400);
  assert.equal(second.status, 429);
  await state.store.close();
});

test("session ttl uses idle ttl when absolute ttl has more remaining time", () => {
  const ttl = computeSessionTtlSeconds(
    { loginTs: 1000, iat: 900 },
    { sessionIdleTtlSeconds: 120, sessionTtlSeconds: 600 },
    1050
  );
  assert.equal(ttl, 120);
});

test("session ttl is capped by absolute ttl remaining from login time", () => {
  const ttl = computeSessionTtlSeconds(
    { loginTs: 1000, iat: 900 },
    { sessionIdleTtlSeconds: 600, sessionTtlSeconds: 600 },
    1400
  );
  assert.equal(ttl, 200);
});

test("session ttl falls back to iat when loginTs is missing", () => {
  const ttl = computeSessionTtlSeconds(
    { iat: 1000 },
    { sessionIdleTtlSeconds: 300, sessionTtlSeconds: 300 },
    1301
  );
  assert.equal(ttl, 0);
});

test("session ttl absolute window resets after re-login", () => {
  const oldSessionTtl = computeSessionTtlSeconds(
    { loginTs: 1000, iat: 900 },
    { sessionIdleTtlSeconds: 300, sessionTtlSeconds: 300 },
    1300
  );
  const refreshedSessionTtl = computeSessionTtlSeconds(
    { loginTs: 1280, iat: 900 },
    { sessionIdleTtlSeconds: 300, sessionTtlSeconds: 300 },
    1300
  );
  assert.equal(oldSessionTtl, 0);
  assert.equal(refreshedSessionTtl, 280);
});

test("config rejects when session idle ttl exceeds absolute session ttl", () => {
  assert.throws(
    () =>
      readOidcOpConfig({
        APP_ENV: "test",
        OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
        OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
        OIDC_SESSION_TTL_SECONDS: "60",
        OIDC_SESSION_IDLE_TTL_SECONDS: "120",
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
      }),
    /OIDC_SESSION_IDLE_TTL_SECONDS must be less than or equal to OIDC_SESSION_TTL_SECONDS/
  );
});

test("config ignores deprecated OIDC_DEMO_* variables", () => {
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_DEMO_CLIENT_SECRET: TEST_DEMO_CLIENT_SECRET,
    OIDC_DEMO_REDIRECT_URI: "https://deprecated.example.com/callback",
    OIDC_DEMO_POST_LOGOUT_REDIRECT_URI: "https://deprecated.example.com/logout",
    OIDC_DEMO_CLIENT_ENABLED: "true",
    OIDC_DEMO_CLIENT_ID: "deprecated-client-id",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  });
  assert.equal(config.oidcClientsConfigPath, "/app/config/oidc-clients.json");
});

test("config rejects missing OIDC_ARTIFACT_ENCRYPTION_SECRET outside test", () => {
  assert.throws(
    () =>
      readOidcOpConfig({
        APP_ENV: "development",
        OIDC_ISSUER: "https://localhost:3003",
        OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
      }),
    /OIDC_ARTIFACT_ENCRYPTION_SECRET is required/
  );
});

test("config rejects short encryption secret outside test", () => {
  assert.throws(
    () =>
      readOidcOpConfig({
        APP_ENV: "development",
        OIDC_ISSUER: "https://localhost:3003",
        OIDC_KEY_ENCRYPTION_SECRET: "short-secret",
        OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
      }),
    /OIDC_KEY_ENCRYPTION_SECRET must be at least 32 characters/
  );
});

test("config rejects identical artifact and key encryption secrets", () => {
  assert.throws(
    () =>
      readOidcOpConfig({
        APP_ENV: "test",
        OIDC_KEY_ENCRYPTION_SECRET: "same-secret",
        OIDC_ARTIFACT_ENCRYPTION_SECRET: "same-secret",
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
      }),
    /OIDC_ARTIFACT_ENCRYPTION_SECRET must be different from OIDC_KEY_ENCRYPTION_SECRET/
  );
});

test("config accepts explicit OIDC_CLIENTS_CONFIG_PATH", () => {
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_CLIENTS_CONFIG_PATH: "/tmp/custom-oidc-clients.json",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  });
  assert.equal(config.oidcClientsConfigPath, "/tmp/custom-oidc-clients.json");
});

test("config defaults AUTH_PROVIDER to cqut", () => {
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  });
  assert.equal(config.authProvider, "cqut");
  assert.equal(config.oidcClientsConfigPath, "/app/config/oidc-clients.json");
  assert.deepEqual(config.cookieKeys, ["test-oidc-key-secret"]);
  assert.equal(config.csrfSigningSecret, "test-oidc-key-secret");
  assert.equal(config.signingKeyRefreshIntervalSeconds, 30);
  assert.equal(config.artifactOpportunisticCleanupEnabled, false);
});

test("config allows AUTH_PROVIDER=mock in test", () => {
  const config = readOidcOpConfig({
    APP_ENV: "test",
    AUTH_PROVIDER: "mock",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  });
  assert.equal(config.authProvider, "mock");
});

test("config defaults email verification global rate limits to strict profile", () => {
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  });
  assert.equal(config.emailVerifyRateLimitSubjectMax, 4);
  assert.equal(config.emailVerifyRateLimitSubjectWindowSeconds, 600);
  assert.equal(config.emailVerifyRateLimitEmailMax, 2);
  assert.equal(config.emailVerifyRateLimitEmailWindowSeconds, 600);
  assert.equal(config.emailVerifyRateLimitDomainMax, 12);
  assert.equal(config.emailVerifyRateLimitDomainWindowSeconds, 600);
  assert.equal(config.emailVerifyRateLimitIpMax, 12);
  assert.equal(config.emailVerifyRateLimitIpWindowSeconds, 600);
});

test("config rejects non-positive email verification global rate limit values", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  };
  const keys = [
    "OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX",
    "OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_WINDOW_SECONDS",
    "OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX",
    "OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_WINDOW_SECONDS",
    "OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX",
    "OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_WINDOW_SECONDS",
    "OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX",
    "OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_WINDOW_SECONDS"
  ] as const;

  for (const key of keys) {
    assert.throws(
      () =>
        readOidcOpConfig({
          ...baseEnv,
          [key]: "0"
        }),
      new RegExp(`${key} must be a positive integer`)
    );
  }
});

test("config allows explicitly enabling opportunistic cleanup", () => {
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
    OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_ENABLED: "true"
  });
  assert.equal(config.artifactOpportunisticCleanupEnabled, true);
});

test("config rejects non-positive signing key refresh interval", () => {
  assert.throws(
    () =>
      readOidcOpConfig({
        APP_ENV: "test",
        OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
        OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
        OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS: "0",
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
      }),
    /OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS must be a positive integer/
  );
});

test("config rejects missing OIDC_COOKIE_KEYS in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          OIDC_COOKIE_KEYS: undefined
        })
      ),
    /OIDC_COOKIE_KEYS is required when APP_ENV=production/
  );
});

test("config rejects missing OIDC_CSRF_SIGNING_SECRET in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          OIDC_CSRF_SIGNING_SECRET: undefined
        })
      ),
    /OIDC_CSRF_SIGNING_SECRET is required when APP_ENV=production/
  );
});

test("config rejects csrf signing secret reused as key encryption secret in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          OIDC_CSRF_SIGNING_SECRET: PROD_KEY_SECRET
        })
      ),
    /OIDC_CSRF_SIGNING_SECRET must be different from OIDC_KEY_ENCRYPTION_SECRET/
  );
});

test("config rejects cookie key reused as key encryption secret in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          OIDC_COOKIE_KEYS: `${PROD_KEY_SECRET},prod-cookie-b-0123456789`
        })
      ),
    /OIDC_COOKIE_KEYS entries must be different from OIDC_KEY_ENCRYPTION_SECRET/
  );
});

test("config rejects cookie key reused as csrf signing secret in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          OIDC_COOKIE_KEYS: `${PROD_CSRF_SECRET},prod-cookie-b-0123456789`
        })
      ),
    /OIDC_COOKIE_KEYS entries must be different from OIDC_CSRF_SIGNING_SECRET/
  );
});

test("config caps csrf token ttl to interaction ttl", () => {
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_INTERACTION_TTL_SECONDS: "120",
    OIDC_CSRF_TOKEN_TTL_SECONDS: "900",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  });
  assert.equal(config.csrfTokenTtlSeconds, 120);
});

test("config rejects non-https issuer outside test", () => {
  assert.throws(
    () =>
      readOidcOpConfig({
        APP_ENV: "development",
        OIDC_ISSUER: "http://localhost:3003",
        OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
        OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
      }),
    /OIDC_ISSUER must use https:\/\//
  );
});

test("config allows loopback http issuer in test", () => {
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_ISSUER: "http://127.0.0.1:3003",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  });
  assert.equal(config.issuer, "http://127.0.0.1:3003");
});

test("config rejects AUTH_PROVIDER=mock outside test", () => {
  assert.throws(
    () =>
      readOidcOpConfig({
        APP_ENV: "development",
        OIDC_ISSUER: "https://localhost:3003",
        AUTH_PROVIDER: "mock",
        OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
        OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
      }),
    /AUTH_PROVIDER=mock is only allowed when APP_ENV=test/
  );
  assert.throws(
    () =>
      readOidcOpConfig({
        APP_ENV: "production",
        OIDC_ISSUER: "https://localhost:3003",
        AUTH_PROVIDER: "mock",
        OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
        OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
      }),
    /AUTH_PROVIDER=mock is only allowed when APP_ENV=test/
  );
});

test("config rejects OIDC_ALLOW_IN_MEMORY_STORE=true in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          OIDC_ALLOW_IN_MEMORY_STORE: "true"
        })
      ),
    /OIDC_ALLOW_IN_MEMORY_STORE=true is not allowed when APP_ENV=production/
  );
});

test("config rejects missing DATABASE_URL in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          DATABASE_URL: undefined
        })
      ),
    /DATABASE_URL is required when APP_ENV=production/
  );
});

test("config rejects missing REDIS_URL in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          REDIS_URL: undefined
        })
      ),
    /REDIS_URL is required when APP_ENV=production/
  );
});

test("config rejects OIDC_RATE_LIMIT_FAIL_CLOSED=false in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          OIDC_RATE_LIMIT_FAIL_CLOSED: "false"
        })
      ),
    /OIDC_RATE_LIMIT_FAIL_CLOSED must be true when APP_ENV=production/
  );
});

test("config rejects TRUST_PROXY_HOPS=0 in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          TRUST_PROXY_HOPS: "0"
        })
      ),
    /TRUST_PROXY_HOPS must be 1 when APP_ENV=production/
  );
});

test("config rejects TRUST_PROXY_HOPS=2 in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          TRUST_PROXY_HOPS: "2"
        })
      ),
    /TRUST_PROXY_HOPS must be 1 when APP_ENV=production/
  );
});

test("config allows TRUST_PROXY_HOPS=0 in test", () => {
  const config = readOidcOpConfig({
    APP_ENV: "test",
    TRUST_PROXY_HOPS: "0",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  });
  assert.equal(config.trustProxyHops, 0);
});

test("deploy nginx templates overwrite X-Forwarded-For instead of appending it", () => {
  const developmentTemplate = readFileSync(
    new URL("../../../deploy/nginx/site.conf", import.meta.url),
    "utf8"
  );
  const productionTemplate = readFileSync(
    new URL("../../../deploy/nginx/site.prod.conf.template", import.meta.url),
    "utf8"
  );

  for (const template of [developmentTemplate, productionTemplate]) {
    assert.match(template, /proxy_set_header X-Forwarded-For \$remote_addr;/);
    assert.doesNotMatch(template, /\$proxy_add_x_forwarded_for/);
  }
});

test("config rejects missing RESEND_API_KEY in production when email verification enabled", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          RESEND_API_KEY: undefined
        })
      ),
    /RESEND_API_KEY is required when APP_ENV=production and email verification is enabled/
  );
});

test("config rejects disabling email verification in production", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          OIDC_EMAIL_VERIFICATION_ENABLED: "false"
        })
      ),
    /OIDC_EMAIL_VERIFICATION_ENABLED must remain enabled when APP_ENV=production/
  );
});

test("config rejects missing OIDC_EMAIL_FROM in production when email verification enabled", () => {
  assert.throws(
    () =>
      readOidcOpConfig(
        createProductionConfigEnv({
          OIDC_EMAIL_FROM: undefined
        })
      ),
    /OIDC_EMAIL_FROM is required when APP_ENV=production and email verification is enabled/
  );
});
