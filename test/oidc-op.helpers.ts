import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { Pool } from "pg";
import { ClientManagementService } from "../src/clients/client-management.service.js";
import { ProjectAccessService } from "../src/projects/project-access.js";
import { SYSTEM_PROJECT_ID } from "../src/persistence/contracts.js";
import { createOidcApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import type { PolicyValues } from "../src/runtime-policy.js";
import {
  createClientSecretDigest,
  decryptJson,
  encryptJson,
  verifyClientSecretDigest,
} from "../src/crypto.js";
import type {
  EmailSender,
  SendVerificationCodeInput,
} from "../src/email/email-sender.js";
import {
  computeSessionTtlSeconds,
  generateSigningKey,
} from "../src/oidc/provider.js";
import { sha256Base64Url } from "../src/utils.js";
import { MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD } from "../src/identity/providers/mock.provider.js";
import { RateLimitUnavailableError } from "../src/persistence/rate-limit.service.js";

export const TEST_REDIRECT_URI = "http://localhost:3002/demo/callback";
export const TEST_POST_LOGOUT_REDIRECT_URI =
  "http://localhost:3002/demo/logout-complete";
export const TEST_DEMO_CLIENT_SECRET = "test-oidc-demo-client-secret";
export const TEST_LOGIN_ACCOUNT = `test-account-${randomUUID()}`;
export const TEST_LOGIN_PASSWORD = `test-password-${randomUUID()}`;
export const TEST_WRONG_LOGIN_PASSWORD = "";
export const PROD_KEY_SECRET = "prod-oidc-key-secret-0123456789abcdef";
export const PROD_ARTIFACT_SECRET = "prod-oidc-artifact-secret-0123456789abcd";
export const PROD_CSRF_SECRET = "prod-oidc-csrf-secret-0123456789abcdef";

export class FakeEmailSender implements EmailSender {
  readonly sentVerifications: SendVerificationCodeInput[] = [];

  async sendVerificationCode(input: SendVerificationCodeInput): Promise<void> {
    this.sentVerifications.push(input);
  }

  latestCode(interactionUid: string, to: string): string | undefined {
    for (
      let index = this.sentVerifications.length - 1;
      index >= 0;
      index -= 1
    ) {
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

export class FlakyEmailSender implements EmailSender {
  shouldFail = true;
  readonly sentVerifications: SendVerificationCodeInput[] = [];

  async sendVerificationCode(input: SendVerificationCodeInput): Promise<void> {
    if (this.shouldFail) {
      throw new Error("email delivery unavailable");
    }
    this.sentVerifications.push(input);
  }
}

export function extractInteractionUid(interactionLocation: string) {
  const match = interactionLocation.match(/^\/interaction\/([^/?#]+)/);
  assert.ok(match?.[1]);
  return decodeURIComponent(match[1]);
}

export function extractCsrf(html: string) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match?.[1]);
  return match[1];
}

export function extractConsentAction(html: string) {
  const match = html.match(/action="([^"]*\/consent)"/);
  assert.ok(match?.[1]);
  return match[1];
}

export function extractFormAction(html: string) {
  const match = html.match(/<form[^>]+action="([^"]+)"/i);
  return match?.[1];
}

export function extractHiddenFormInputs(html: string) {
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

export function getSetCookieValue(
  response: request.Response,
  name: string,
): string | undefined {
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

export function assertApplicationSecurityHeaders(
  response: request.Response,
  options: { expectClientRedirectFormAction?: boolean } = {},
) {
  const csp = response.headers["content-security-policy"] as string;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  if (options.expectClientRedirectFormAction) {
    assert.match(csp, /form-action [^;]*http:\/\/localhost:3002/);
  }
  assert.doesNotMatch(csp, /form-action [^;]*\*/);
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
}

export function assertLogoutPageSecurityHeaders(response: request.Response) {
  assertApplicationSecurityHeaders(response, {
    expectClientRedirectFormAction: false,
  });
}

export function assertInlineScriptNonceMatchesCsp(response: request.Response) {
  const scriptNonce = response.text.match(/<script nonce="([^"]+)">/)?.[1];
  const cspNonce = (
    response.headers["content-security-policy"] as string
  ).match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(scriptNonce);
  assert.equal(scriptNonce, cspNonce);
}

export function tamperToken(token: string) {
  if (token.length === 0) {
    return token;
  }
  const suffix = token.endsWith("a") ? "b" : "a";
  return `${token.slice(0, -1)}${suffix}`;
}

export function decodeJwtPayload(token: string) {
  const [, payload] = token.split(".");
  if (typeof payload !== "string") {
    throw new Error("JWT payload segment is missing");
  }
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

export function normalizeActionPath(action: string) {
  if (/^https?:\/\//.test(action)) {
    const url = new URL(action);
    return `${url.pathname}${url.search}`;
  }
  return action;
}

export function withHeaders(
  testRequest: request.Test,
  headers?: Record<string, string>,
) {
  if (!headers) {
    return testRequest;
  }
  for (const [name, value] of Object.entries(headers)) {
    testRequest.set(name, value);
  }
  return testRequest;
}

export async function createTestApp(): Promise<{
  app: Awaited<ReturnType<typeof createOidcApp>>["app"];
  state: Awaited<ReturnType<typeof createOidcApp>>["state"];
  emailSender: FakeEmailSender;
}>;
export async function createTestApp(overrides: NodeJS.ProcessEnv): Promise<{
  app: Awaited<ReturnType<typeof createOidcApp>>["app"];
  state: Awaited<ReturnType<typeof createOidcApp>>["state"];
  emailSender: FakeEmailSender;
}>;
export async function createTestApp<T extends EmailSender>(
  overrides: NodeJS.ProcessEnv,
  options: { emailSender: T },
): Promise<{
  app: Awaited<ReturnType<typeof createOidcApp>>["app"];
  state: Awaited<ReturnType<typeof createOidcApp>>["state"];
  emailSender: T;
}>;
export async function createTestApp(
  overrides: NodeJS.ProcessEnv = {},
  options: { emailSender?: EmailSender } = {},
) {
  const emailSender = options.emailSender ?? new FakeEmailSender();
  const clientsConfigPath =
    overrides["OIDC_CLIENTS_CONFIG_PATH"] ??
    (await writeTestClientsConfig({ autoConsent: true }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: "test",
    AUTH_PROVIDER: "mock",
    OIDC_COOKIE_SECURE: "false",
    OIDC_ISSUER: "http://127.0.0.1:3003",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_CLIENT_SECRET_ROTATE_MINIMUM_INTERVAL_SECONDS: "0",
    OIDC_CLIENTS_CONFIG_PATH: clientsConfigPath,
    ...overrides,
  };
  const appWithState = await createOidcApp(env, {
    emailSender,
    runtimePolicyOverrides: testPolicyOverrides(overrides),
  });
  return {
    ...appWithState,
    emailSender,
  };
}

export function testPolicyOverrides(
  env: NodeJS.ProcessEnv,
): Partial<PolicyValues> {
  const names: Record<string, keyof PolicyValues> = {
    OIDC_CSRF_TOKEN_TTL_SECONDS: "csrfTokenTtlSeconds",
    OIDC_SESSION_TTL_SECONDS: "sessionTtlSeconds",
    OIDC_SESSION_IDLE_TTL_SECONDS: "sessionIdleTtlSeconds",
    OIDC_INTERACTION_TTL_SECONDS: "interactionTtlSeconds",
    OIDC_EMAIL_VERIFY_CODE_TTL_SECONDS: "emailVerifyCodeTtlSeconds",
    OIDC_EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS:
      "emailVerifyResendCooldownSeconds",
    OIDC_EMAIL_VERIFY_MAX_ATTEMPTS: "emailVerifyMaxAttempts",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "emailVerifyRateLimitSubjectMax",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_WINDOW_SECONDS:
      "emailVerifyRateLimitSubjectWindowSeconds",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "emailVerifyRateLimitEmailMax",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_WINDOW_SECONDS:
      "emailVerifyRateLimitEmailWindowSeconds",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "emailVerifyRateLimitDomainMax",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_WINDOW_SECONDS:
      "emailVerifyRateLimitDomainWindowSeconds",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "emailVerifyRateLimitIpMax",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_WINDOW_SECONDS:
      "emailVerifyRateLimitIpWindowSeconds",
    OIDC_LOGIN_RATE_LIMIT_MAX: "loginRateLimitMax",
    OIDC_LOGIN_RATE_LIMIT_WINDOW_SECONDS: "loginRateLimitWindowSeconds",
    OIDC_LOGIN_FAILURE_LIMIT: "loginFailureLimit",
    OIDC_LOGIN_FAILURE_WINDOW_SECONDS: "loginFailureWindowSeconds",
    OIDC_TOKEN_RATE_LIMIT_MAX: "tokenRateLimitMax",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "tokenRateLimitWindowSeconds",
    OIDC_CLIENT_SECRET_ROTATE_MINIMUM_INTERVAL_SECONDS:
      "clientSecretRotateMinimumIntervalSeconds",
  };
  const result: Partial<PolicyValues> = {};
  for (const [name, key] of Object.entries(names)) {
    if (env[name] !== undefined) {
      (result as Record<string, number>)[key] = Number(env[name]);
    }
  }
  return result;
}

export function createProductionConfigEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    APP_ENV: "production",
    AUTH_PROVIDER: "cqut",
    OIDC_ISSUER: "https://auth.example.com",
    OIDC_CLIENTS_CONFIG_PATH: "/app/config/oidc-clients.json",
    OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
    OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
    OIDC_COOKIE_KEYS:
      "prod-oidc-cookie-key-a-0123456789,prod-oidc-cookie-key-b-0123456789",
    OIDC_CSRF_SIGNING_SECRET: PROD_CSRF_SECRET,
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
    DATABASE_URL: "postgres://127.0.0.1:5432/oidc",
    REDIS_URL: "redis://127.0.0.1:6379",
    OIDC_ALLOW_IN_MEMORY_STORE: "false",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "true",
    ...overrides,
  };
  return env;
}

export async function writeTestClientsConfig(
  patch: Partial<{
    clientSecretDigest: string | undefined;
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    autoConsent: boolean;
    status: "active" | "disabled";
  }> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "oidc-clients-"));
  const configPath = join(directory, "oidc-clients.json");
  const clientSecretDigest =
    patch.clientSecretDigest ??
    (await createClientSecretDigest(TEST_DEMO_CLIENT_SECRET));
  const payload = {
    clients: [
      {
        clientId: "demo-site",
        clientSecretDigest,
        grantTypes: ["authorization_code", "refresh_token"],
        scopeWhitelist: [
          "openid",
          "profile",
          "email",
          "student",
          "offline_access",
        ],
        redirectUris: patch.redirectUris ?? [TEST_REDIRECT_URI],
        postLogoutRedirectUris: patch.postLogoutRedirectUris ?? [
          TEST_POST_LOGOUT_REDIRECT_URI,
        ],
        autoConsent: patch.autoConsent ?? false,
        status: patch.status ?? "active",
      },
    ],
  };
  writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return configPath;
}

export async function followToRedirectUriOrigin(
  agent: any,
  response: request.Response,
  redirectUri: string,
) {
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

export async function runAuthorizationFlow(
  agent: any,
  emailSender: FakeEmailSender,
  state = "state-1",
) {
  const { response, codeVerifier } = await authorizeThroughProfile(
    agent,
    emailSender,
    state,
    "openid profile email student offline_access",
  );
  const externalRedirect = await followToRedirectUriOrigin(
    agent,
    response,
    TEST_REDIRECT_URI,
  );
  const callbackUrl = new URL(externalRedirect);
  assert.equal(callbackUrl.origin + callbackUrl.pathname, TEST_REDIRECT_URI);
  assert.equal(callbackUrl.searchParams.get("state"), state);
  const code = callbackUrl.searchParams.get("code");
  assert.ok(code);

  return {
    code: code as string,
    codeVerifier,
  };
}

export async function disableDemoAutoConsent(state: {
  persistence: {
    clients: { upsertOidcClient: (client: any) => Promise<unknown> };
  };
}) {
  await upsertDemoClient(state);
}

export async function upsertDemoClient(
  state: {
    persistence: {
      clients: { upsertOidcClient: (client: any) => Promise<unknown> };
    };
  },
  patch: Partial<{
    clientSecretDigest: string | undefined;
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    status: "active" | "disabled";
    autoConsent: boolean;
  }> = {},
) {
  const now = new Date().toISOString();
  const clientSecretDigest =
    patch.clientSecretDigest ??
    (await createClientSecretDigest(TEST_DEMO_CLIENT_SECRET));
  const redirectUris = patch.redirectUris ?? [TEST_REDIRECT_URI];
  const postLogoutRedirectUris = patch.postLogoutRedirectUris ?? [
    TEST_POST_LOGOUT_REDIRECT_URI,
  ];
  const scopeWhitelist = [
    "openid",
    "profile",
    "email",
    "student",
    "offline_access",
  ] as const;
  await state.persistence.clients.upsertOidcClient({
    clientId: "demo-site",
    clientSecretDigests: [clientSecretDigest],
    displayName: "Demo Site",
    description: "",
    projectId: "system",
    createdBySubjectId: null,
    clientType: "web",
    lifecycleStatus: patch.status ?? "active",
    activeRevisionId: 0,
    authorizationGeneration: 1,
    activeRevision: {
      revisionId: 0,
      clientId: "demo-site",
      revisionNumber: 1,
      status: "approved",
      redirectUris,
      postLogoutRedirectUris,
      scopeWhitelist: [...scopeWhitelist],
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    applicationType: "web",
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris,
    postLogoutRedirectUris,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopeWhitelist: [...scopeWhitelist],
    requirePkce: true,
    allowRefreshTokenForPublicClient: false,
    autoConsent: patch.autoConsent ?? false,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
}

export async function upsertPublicNoneClient(
  state: {
    persistence: {
      clients: { upsertOidcClient: (client: any) => Promise<unknown> };
    };
  },
  clientId: string,
  patch: Partial<{
    grantTypes: string[];
    scopeWhitelist: Array<
      "openid" | "profile" | "email" | "offline_access" | "student"
    >;
    allowRefreshTokenForPublicClient: boolean;
  }> = {},
) {
  const now = new Date().toISOString();
  const scopeWhitelist = patch.scopeWhitelist ?? [
    "openid",
    "profile",
    "email",
    "student",
  ];
  await state.persistence.clients.upsertOidcClient({
    clientId,
    clientSecretDigests: [],
    displayName: clientId,
    description: "",
    projectId: "system",
    createdBySubjectId: null,
    clientType: "spa",
    lifecycleStatus: "active",
    activeRevisionId: 0,
    authorizationGeneration: 1,
    activeRevision: {
      revisionId: 0,
      clientId,
      revisionNumber: 1,
      status: "approved",
      redirectUris: [TEST_REDIRECT_URI],
      postLogoutRedirectUris: [TEST_POST_LOGOUT_REDIRECT_URI],
      scopeWhitelist,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    applicationType: "web",
    tokenEndpointAuthMethod: "none",
    redirectUris: [TEST_REDIRECT_URI],
    postLogoutRedirectUris: [TEST_POST_LOGOUT_REDIRECT_URI],
    grantTypes: patch.grantTypes ?? ["refresh_token"],
    responseTypes: ["code"],
    scopeWhitelist,
    requirePkce: true,
    allowRefreshTokenForPublicClient:
      patch.allowRefreshTokenForPublicClient ?? true,
    autoConsent: false,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 150,
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

export async function followToConsentPage(
  agent: any,
  response: request.Response,
) {
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

export async function authorizeThroughProfile(
  agent: any,
  emailSender: FakeEmailSender,
  state: string,
  scope = "openid profile",
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
    code_challenge_method: "S256",
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
      password: TEST_LOGIN_PASSWORD,
    });
  assert.ok(login.status === 302 || login.status === 303);
  if (!scope.split(/\s+/).includes("email")) {
    return {
      response: login,
      codeVerifier: verifier,
      profileLocation: undefined,
      interactionUid: extractInteractionUid(interactionLocation),
    };
  }
  assert.match(
    login.headers["location"] as string,
    /\/interaction\/.+\/profile/,
  );

  const profileLocation = login.headers["location"] as string;
  const interactionUid = extractInteractionUid(interactionLocation);
  const profilePage = await agent.get(profileLocation);
  assert.equal(profilePage.status, 200);
  const profileCsrf = extractCsrf(profilePage.text);
  const sendCode = await agent.post(profileLocation).type("form").send({
    csrf: profileCsrf,
    action: "send_code",
    email: "demo@example.com",
  });
  assert.equal(sendCode.status, 200);
  const verifyCsrf = extractCsrf(sendCode.text);
  const sentCode = emailSender.latestCode(interactionUid, "demo@example.com");
  assert.equal(typeof sentCode, "string");
  const profile = await agent.post(profileLocation).type("form").send({
    csrf: verifyCsrf,
    action: "verify_code",
    code: sentCode,
  });
  return {
    response: profile,
    codeVerifier: verifier,
    profileLocation,
    interactionUid,
  };
}

export async function runAuthorizationToConsent(
  agent: any,
  emailSender: FakeEmailSender,
  state: string,
  scope = "openid profile",
) {
  const { response, codeVerifier } = await authorizeThroughProfile(
    agent,
    emailSender,
    state,
    scope,
  );
  const consentPageHtml = await followToConsentPage(agent, response);
  const consentCsrf = extractCsrf(consentPageHtml);
  const consentAction = extractConsentAction(consentPageHtml);
  return { consentAction, consentCsrf, codeVerifier };
}

export async function startEmailVerification(
  agent: any,
  emailSender: FakeEmailSender,
  state: string,
  email = "demo@example.com",
): Promise<{
  profileLocation: string;
  interactionUid: string;
  code: string;
  sendCode: request.Response;
}> {
  const { interactionUid, profileLocation, sendCode } =
    await sendEmailVerificationCode(agent, state, email);
  assert.equal(sendCode.status, 200);
  const code = emailSender.latestCode(interactionUid, email);
  assert.equal(typeof code, "string");
  return {
    profileLocation,
    interactionUid,
    code: code as string,
    sendCode,
  };
}

export async function sendEmailVerificationCode(
  agent: any,
  state: string,
  email: string,
  headers?: Record<string, string>,
): Promise<{
  interactionUid: string;
  profileLocation: string;
  sendCode: request.Response;
}> {
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    state,
    headers,
  );
  const interactionUid = extractInteractionUid(interactionLocation);
  const loginCsrf = extractCsrf(loginPage.text);
  const login = await withHeaders(
    agent.post(`${interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: loginCsrf,
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD,
    });
  assert.equal(login.status, 302);
  assert.match(
    login.headers["location"] as string,
    /\/interaction\/.+\/profile/,
  );
  const profileLocation = login.headers["location"] as string;
  const profilePage = await withHeaders(agent.get(profileLocation), headers);
  assert.equal(profilePage.status, 200);
  const profileCsrf = extractCsrf(profilePage.text);
  const sendCode = await withHeaders(agent.post(profileLocation), headers)
    .type("form")
    .send({
      csrf: profileCsrf,
      action: "send_code",
      email,
    });
  return {
    interactionUid,
    profileLocation,
    sendCode,
  };
}

export async function openLoginInteraction(
  agent: any,
  state = "login-state-1",
  headers?: Record<string, string>,
  scope = "openid profile email",
): Promise<{
  interactionLocation: string;
  loginPage: request.Response;
}> {
  const authorize = await withHeaders(agent.get("/auth"), headers).query({
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope,
    prompt: "consent",
    state,
    nonce: "nonce-login-1",
    code_challenge: sha256Base64Url(
      "login-verifier-login-verifier-login-verifier",
    ),
    code_challenge_method: "S256",
  });
  assert.ok(authorize.status === 302 || authorize.status === 303);
  const interactionLocation = authorize.headers["location"] as string;
  const loginPage = await withHeaders(agent.get(interactionLocation), headers);
  assert.equal(loginPage.status, 200);
  return {
    interactionLocation,
    loginPage,
  };
}

export function assertAuthErrorRedirect(location: string) {
  const redirect = new URL(location);
  const hashParams = new URLSearchParams(
    redirect.hash.startsWith("#") ? redirect.hash.slice(1) : "",
  );
  const code = redirect.searchParams.get("code") ?? hashParams.get("code");
  const error = redirect.searchParams.get("error") ?? hashParams.get("error");
  assert.equal(redirect.origin + redirect.pathname, TEST_REDIRECT_URI);
  assert.equal(code, null);
  assert.equal(typeof error, "string");
}

export async function assertAuthorizationRequestRejected(
  agent: any,
  query: Record<string, string>,
) {
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

export {
  assert,
  createHmac,
  randomUUID,
  mkdtempSync,
  writeFileSync,
  tmpdir,
  join,
  request,
  Pool,
  ClientManagementService,
  ProjectAccessService,
  SYSTEM_PROJECT_ID,
  createOidcApp,
  readConfig,
  PolicyValues,
  createClientSecretDigest,
  decryptJson,
  encryptJson,
  verifyClientSecretDigest,
  EmailSender,
  SendVerificationCodeInput,
  computeSessionTtlSeconds,
  generateSigningKey,
  sha256Base64Url,
  MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD,
  RateLimitUnavailableError,
};
