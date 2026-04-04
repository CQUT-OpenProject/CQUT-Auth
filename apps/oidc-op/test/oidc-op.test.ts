import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createOidcApp } from "../src/app.js";
import { readOidcOpConfig } from "../src/config.js";
import { sha256Base64Url } from "../src/utils.js";

const TEST_REDIRECT_URI = "http://localhost:3002/demo/callback";

function basicAuth(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

function extractCsrf(html: string) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match?.[1]);
  return match[1];
}

async function createTestApp(overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: "test",
    AUTH_PROVIDER: "mock",
    OIDC_COOKIE_SECURE: "false",
    OIDC_ISSUER: "http://127.0.0.1:3003",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_DEMO_CLIENT_ID: "demo-site",
    OIDC_DEMO_CLIENT_SECRET: "demo-site-secret",
    OIDC_DEMO_REDIRECT_URI: TEST_REDIRECT_URI,
    OIDC_DEMO_POST_LOGOUT_REDIRECT_URI: "http://localhost:3002/demo",
    ...overrides
  };
  return createOidcApp(env);
}

async function followInternalRedirects(agent: any, response: request.Response) {
  let current = response;
  while (current.status >= 300 && current.status < 400) {
    const location = current.headers["location"];
    assert.ok(location);
    if (/^https?:\/\//.test(location)) {
      const url = new URL(location);
      if (url.origin === new URL(TEST_REDIRECT_URI).origin) {
        return location;
      }
      current = await agent.get(`${url.pathname}${url.search}`);
      continue;
    }
    current = await agent.get(location);
  }
  throw new Error("expected external redirect");
}

async function runAuthorizationFlow(agent: any, state = "state-1") {
  const verifier = "verifier-1234567890-verifier-1234567890-verifier";
  const challenge = sha256Base64Url(verifier);
  const authorize = await agent.get("/auth").query({
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email student offline_access",
    prompt: "consent",
    state,
    nonce: "nonce-1",
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
      account: "20240001",
      password: "mock-password"
    });
  assert.equal(login.status, 302);
  assert.match(login.headers["location"] as string, /\/interaction\/.+\/profile/);

  const profileLocation = login.headers["location"] as string;
  const profilePage = await agent.get(profileLocation);
  assert.equal(profilePage.status, 200);
  const profileCsrf = extractCsrf(profilePage.text);
  const profile = await agent
    .post(profileLocation)
    .type("form")
    .send({
      csrf: profileCsrf,
      email: "demo@example.com"
    });

  const externalRedirect = await followInternalRedirects(agent, profile);
  const callbackUrl = new URL(externalRedirect);
  assert.equal(callbackUrl.origin + callbackUrl.pathname, TEST_REDIRECT_URI);
  assert.equal(callbackUrl.searchParams.get("state"), state);
  const code = callbackUrl.searchParams.get("code");
  assert.ok(code);

  return {
    code: code as string,
    codeVerifier: verifier
  };
}

test("discovery and jwks endpoints are available", async () => {
  const { app, state } = await createTestApp();
  const http = request(app);

  const discovery = await http.get("/.well-known/openid-configuration");
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.issuer, "http://127.0.0.1:3003");
  assert.equal(new URL(discovery.body.authorization_endpoint).pathname, "/auth");
  assert.equal(new URL(discovery.body.userinfo_endpoint).pathname, "/userinfo");

  const jwks = await http.get("/jwks");
  assert.equal(jwks.status, 200);
  assert.equal(Array.isArray(jwks.body.keys), true);
  assert.equal(jwks.body.keys[0]?.alg, "RS256");

  await state.store.close();
});

test("authorization code flow, userinfo, refresh rotation, and session reuse work", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);

  const { code, codeVerifier } = await runAuthorizationFlow(agent, "state-1");

  const token = await request(app)
    .post("/token")
    .set("Authorization", basicAuth("demo-site", "demo-site-secret"))
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
  assert.equal(userinfo.body.email_verified, false);
  assert.equal(userinfo.body.school, "cqut");
  assert.equal(userinfo.body.student_status, "active_student");

  const secondAuthorize = await agent.get("/auth").query({
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email student offline_access",
    prompt: "consent",
    state: "state-2",
    nonce: "nonce-2",
    code_challenge: sha256Base64Url("another-verifier-another-verifier-another-verifier"),
    code_challenge_method: "S256"
  });
  assert.ok(secondAuthorize.status === 302 || secondAuthorize.status === 303);
  const secondRedirect = await followInternalRedirects(agent, secondAuthorize);
  assert.match(secondRedirect, /^http:\/\/localhost:3002\/demo\/callback\?/);

  const rotated = await request(app)
    .post("/token")
    .set("Authorization", basicAuth("demo-site", "demo-site-secret"))
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
    .set("Authorization", basicAuth("demo-site", "demo-site-secret"))
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token as string
    });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, "invalid_grant");

  await state.store.close();
});

test("token endpoint returns 503 when rate limiter is fail-closed and redis is unavailable", async () => {
  const { app, state } = await createTestApp({
    REDIS_URL: "redis://127.0.0.1:1",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "true"
  });
  const response = await request(app)
    .post("/token")
    .set("Authorization", basicAuth("demo-site", "demo-site-secret"))
    .type("form")
    .send({ grant_type: "client_credentials" });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "service_unavailable");
  await state.store.close();
});

test("config rejects when session idle ttl exceeds absolute session ttl", () => {
  assert.throws(
    () =>
      readOidcOpConfig({
        APP_ENV: "test",
        OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
        OIDC_SESSION_TTL_SECONDS: "60",
        OIDC_SESSION_IDLE_TTL_SECONDS: "120",
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
      }),
    /OIDC_SESSION_IDLE_TTL_SECONDS must be less than or equal to OIDC_SESSION_TTL_SECONDS/
  );
});
