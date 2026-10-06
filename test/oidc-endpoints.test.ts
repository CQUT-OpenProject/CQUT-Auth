import { test } from "vite-plus/test";
import {
  ClientManagementService,
  ProjectAccessService,
  SYSTEM_PROJECT_ID,
  TEST_DEMO_CLIENT_SECRET,
  TEST_LOGIN_ACCOUNT,
  TEST_LOGIN_PASSWORD,
  TEST_REDIRECT_URI,
  assert,
  assertApplicationSecurityHeaders,
  assertAuthorizationRequestRejected,
  assertInlineScriptNonceMatchesCsp,
  assertLogoutPageSecurityHeaders,
  createClientSecretDigest,
  createTestApp,
  decryptJson,
  encryptJson,
  extractConsentAction,
  extractCsrf,
  followToConsentPage,
  followToRedirectUriOrigin,
  generateSigningKey,
  getSetCookieValue,
  normalizeActionPath,
  openLoginInteraction,
  request,
  sha256Base64Url,
  tamperToken,
  upsertDemoClient,
  upsertPublicNoneClient,
  verifyClientSecretDigest,
  waitFor,
} from "./oidc-op.helpers.js";

test("discovery and jwks endpoints are available", async () => {
  const { app, state } = await createTestApp();
  const http = request(app);

  const discovery = await http.get("/.well-known/openid-configuration");
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.issuer, "http://127.0.0.1:3003");
  assert.equal(
    new URL(discovery.body.authorization_endpoint).pathname,
    "/auth",
  );
  assert.equal(new URL(discovery.body.userinfo_endpoint).pathname, "/userinfo");
  assert.deepEqual(discovery.body.response_types_supported, ["code"]);
  assert.deepEqual(discovery.body.grant_types_supported, [
    "authorization_code",
    "refresh_token",
  ]);
  assert.deepEqual(discovery.body.subject_types_supported, ["public"]);
  assert.deepEqual(discovery.body.code_challenge_methods_supported, ["S256"]);
  assert.equal(
    Object.hasOwn(discovery.body as object, "registration_endpoint"),
    false,
  );
  assert.equal(
    Object.hasOwn(discovery.body as object, "introspection_endpoint"),
    false,
  );
  assert.equal(
    Object.hasOwn(discovery.body as object, "revocation_endpoint"),
    false,
  );
  assert.equal(
    Object.hasOwn(discovery.body as object, "device_authorization_endpoint"),
    false,
  );

  const jwks = await http.get("/jwks");
  assert.equal(jwks.status, 200);
  assert.equal(Array.isArray(jwks.body.keys), true);
  assert.equal(jwks.body.keys[0]?.alg, "RS256");

  await state.persistence.runtime.close();
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

  await state.persistence.runtime.close();
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
    code_challenge_method: "S256",
  });

  await state.persistence.runtime.close();
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
    nonce: "missing-pkce-nonce",
  });

  await assertAuthorizationRequestRejected(agent, {
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile",
    state: "plain-pkce-method",
    nonce: "plain-pkce-method-nonce",
    code_challenge: "plain-challenge",
    code_challenge_method: "plain",
  });

  await state.persistence.runtime.close();
});

test("application sets security headers on interactive and provider pages", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { loginPage } = await openLoginInteraction(
    agent,
    "security-headers-state",
  );
  assertApplicationSecurityHeaders(loginPage, {
    expectClientRedirectFormAction: true,
  });
  assertInlineScriptNonceMatchesCsp(loginPage);

  const errorPage = await request(app).get("/auth");
  assert.ok(errorPage.status >= 400);
  assertApplicationSecurityHeaders(errorPage, {
    expectClientRedirectFormAction: true,
  });

  const logoutPage = await agent.get("/session/end").query({
    client_id: "demo-site",
  });
  assert.equal(logoutPage.status, 200);
  assertLogoutPageSecurityHeaders(logoutPage);
  await state.persistence.runtime.close();
});

test("interaction page sets HttpOnly csrf nonce cookie with SameSite Lax", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { loginPage } = await openLoginInteraction(
    agent,
    "csrf-cookie-attrs-state",
  );
  assert.equal(loginPage.status, 200);
  extractCsrf(loginPage.text);

  const nonceSetCookie = (
    loginPage.headers["set-cookie"] as string[] | undefined
  )?.find((cookie) => cookie.startsWith("op_csrf_nonce="));
  assert.ok(nonceSetCookie);
  assert.match(nonceSetCookie as string, /;\s*HttpOnly/i);
  assert.match(nonceSetCookie as string, /;\s*SameSite=Lax/i);
  assert.doesNotMatch(nonceSetCookie as string, /;\s*Secure/i);

  await state.persistence.runtime.close();
});

test("interactive login follows the shared brand and accessibility rules", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { loginPage } = await openLoginInteraction(agent, "login-brand-rules");

  assert.match(loginPage.text, /src="\/logo-auth-color\.svg"/);
  assert.match(loginPage.text, /src="\/logo-auth-mono-light\.svg"/);
  assert.match(loginPage.text, /<label for="login-account">账号<\/label>/);
  assert.match(loginPage.text, /<label for="login-password">密码<\/label>/);
  assert.match(loginPage.text, /本服务由 CQUT-OpenProject 提供/);
  assert.match(
    loginPage.text,
    /\* 「CQUT-OpenProject」是由学生及贡献者维护的开源社区，亦不代表学校官方或任何机构/,
  );
  assert.match(loginPage.text, /data-password-toggle/);
  assert.match(loginPage.text, /aria-label="显示密码" aria-pressed="false"/);
  assert.match(loginPage.text, /class="password-icon-hidden"/);
  assert.match(loginPage.text, /class="password-icon-visible"/);
  assert.match(
    loginPage.text,
    /\.password-toggle svg\.password-icon-visible \{ display: none; \}/,
  );
  assert.match(
    loginPage.text,
    /:root \.password-control > button\.password-toggle \{[\s\S]*?background: transparent;[\s\S]*?border: 0;/,
  );
  assert.doesNotMatch(
    loginPage.text,
    /重庆理工大学统一身份认证 · OpenID Connect/,
  );

  await state.persistence.runtime.close();
});

test("csrf rejects tampered token", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "csrf-tamper-state",
  );
  const csrf = extractCsrf(loginPage.text);

  const response = await agent
    .post(`${interactionLocation}/login`)
    .type("form")
    .send({
      csrf: tamperToken(csrf),
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD,
    });
  assert.equal(response.status, 400);
  assert.match(response.text, /CSRF 校验失败，请刷新后重试/);

  await state.persistence.runtime.close();
});

test("csrf rejects token reuse across interaction uid", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "csrf-uid-a",
  );
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
    code_challenge_method: "S256",
  });
  assert.ok(secondAuthorize.status === 302 || secondAuthorize.status === 303);
  const secondInteractionLocation = secondAuthorize.headers[
    "location"
  ] as string;
  assert.match(secondInteractionLocation, /^\/interaction\//);
  assert.notEqual(secondInteractionLocation, interactionLocation);

  const response = await agent
    .post(`${secondInteractionLocation}/login`)
    .type("form")
    .send({
      csrf,
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD,
    });
  assert.equal(response.status, 400);
  assert.match(response.text, /CSRF 校验失败，请刷新后重试/);

  await state.persistence.runtime.close();
});

test("csrf rejects missing or mismatched nonce cookie", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "csrf-nonce-state",
  );
  const csrf = extractCsrf(loginPage.text);

  const withoutCookie = await request(app)
    .post(`${interactionLocation}/login`)
    .type("form")
    .send({
      csrf,
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD,
    });
  assert.equal(withoutCookie.status, 400);

  const withWrongCookie = await request(app)
    .post(`${interactionLocation}/login`)
    .set("Cookie", "op_csrf_nonce=invalid")
    .type("form")
    .send({
      csrf,
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD,
    });
  assert.equal(withWrongCookie.status, 400);
  assert.match(withWrongCookie.text, /CSRF 校验失败，请刷新后重试/);

  await state.persistence.runtime.close();
});

test("csrf rejects malformed percent-encoded cookies without 500", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "csrf-malformed-cookie-state",
  );
  const csrf = extractCsrf(loginPage.text);

  const response = await request(app)
    .post(`${interactionLocation}/login`)
    .set("Cookie", "op_csrf_nonce=%E0%A4%A")
    .type("form")
    .send({
      csrf,
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD,
    });
  assert.equal(response.status, 400);
  assert.match(response.text, /CSRF 校验失败，请刷新后重试/);

  await state.persistence.runtime.close();
});

test("csrf rejects expired token", async () => {
  const { app, state } = await createTestApp({
    OIDC_CSRF_TOKEN_TTL_SECONDS: "1",
  });
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "csrf-expired-state",
  );
  const csrf = extractCsrf(loginPage.text);

  await new Promise((resolve) => setTimeout(resolve, 2100));

  const response = await agent
    .post(`${interactionLocation}/login`)
    .type("form")
    .send({
      csrf,
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD,
    });
  assert.equal(response.status, 400);
  assert.match(response.text, /CSRF 校验失败，请刷新后重试/);

  await state.persistence.runtime.close();
});

test("client secret digest uses scrypt and rejects non-scrypt legacy format", async () => {
  const digest = await createClientSecretDigest(TEST_DEMO_CLIENT_SECRET);
  assert.match(digest, /^scrypt\$/);
  assert.equal(
    await verifyClientSecretDigest(TEST_DEMO_CLIENT_SECRET, digest),
    true,
  );
  assert.equal(await verifyClientSecretDigest("wrong-secret", digest), false);
  assert.equal(
    await verifyClientSecretDigest(
      TEST_DEMO_CLIENT_SECRET,
      "legacy-sha256-digest",
    ),
    false,
  );
});

test("encryptJson uses versioned scrypt envelope and rejects tampered version", async () => {
  const ciphertext = await encryptJson(TEST_DEMO_CLIENT_SECRET, {
    value: "top-secret",
  });
  assert.match(ciphertext, /^v2\$scrypt\$/);
  const parsed = await decryptJson<{ value: string }>(
    TEST_DEMO_CLIENT_SECRET,
    ciphertext,
  );
  assert.equal(parsed.value, "top-secret");

  const tampered = ciphertext.replace(/^v2\$scrypt\$/, "v1$scrypt$");
  await assert.rejects(
    () => decryptJson(TEST_DEMO_CLIENT_SECRET, tampered),
    /unsupported ciphertext version/,
  );
  await assert.rejects(() => decryptJson("wrong-secret", ciphertext));
});

test("seeded demo client is confidential web client", async () => {
  const { state } = await createTestApp();
  const client = await state.persistence.clients.findOidcClient("demo-site");
  assert.ok(client);
  assert.equal(client?.applicationType, "web");
  assert.equal(client?.tokenEndpointAuthMethod, "client_secret_basic");
  assert.equal(client?.clientSecretDigests.length, 1);
  assert.equal(client?.allowRefreshTokenForPublicClient, false);
  assert.equal(
    await verifyClientSecretDigest(
      TEST_DEMO_CLIENT_SECRET,
      client!.clientSecretDigests[0]!,
    ),
    true,
  );
  assert.equal(client?.autoConsent, true);
  await state.persistence.runtime.close();
});

test("public client without explicit refresh confirmation does not receive refresh token", async () => {
  const { app, state } = await createTestApp();
  await upsertPublicNoneClient(state, "public-unconfirmed", {
    allowRefreshTokenForPublicClient: false,
  });
  const agent = request.agent(app);
  const verifier = "public-verifier-1234567890-public-verifier-1234567890";
  const challenge = sha256Base64Url(verifier);

  const authorize = await agent.get("/auth").query({
    client_id: "public-unconfirmed",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile offline_access",
    prompt: "consent",
    state: "public-unconfirmed-state",
    nonce: "public-unconfirmed-nonce",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  assert.ok(authorize.status === 302 || authorize.status === 303);
  const interactionLocation = authorize.headers["location"] as string;
  const loginPage = await agent.get(interactionLocation);
  const login = await agent
    .post(`${interactionLocation}/login`)
    .type("form")
    .send({
      csrf: extractCsrf(loginPage.text),
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD,
    });
  assert.ok(login.status === 302 || login.status === 303);
  assert.doesNotMatch(login.headers["location"] as string, /\/profile/);
  const consentPageHtml = await followToConsentPage(agent, login);
  const consent = await agent
    .post(normalizeActionPath(extractConsentAction(consentPageHtml)))
    .type("form")
    .send({
      csrf: extractCsrf(consentPageHtml),
      action: "approve",
    });
  const externalRedirect = await followToRedirectUriOrigin(
    agent,
    consent,
    TEST_REDIRECT_URI,
  );
  const code = new URL(externalRedirect).searchParams.get("code");
  assert.equal(typeof code, "string");

  const token = await request(app).post("/token").type("form").send({
    grant_type: "authorization_code",
    client_id: "public-unconfirmed",
    code,
    redirect_uri: TEST_REDIRECT_URI,
    code_verifier: verifier,
  });
  assert.equal(token.status, 200);
  assert.equal(typeof token.body.access_token, "string");
  assert.equal(token.body.refresh_token, undefined);
  await state.persistence.runtime.close();
});

test("client disable takes effect immediately without restart", async () => {
  const { app, state } = await createTestApp();
  await upsertDemoClient(state, { status: "disabled" });
  const response = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: "missing-token-disabled-client",
    });
  assert.ok(response.status === 400 || response.status === 401);
  assert.equal(response.body.error, "invalid_client");
  await state.persistence.runtime.close();
});

test("redirect uri updates take effect immediately without restart", async () => {
  const { app, state } = await createTestApp();
  const updatedRedirectUri = "http://localhost:3002/demo/callback-updated";
  await upsertDemoClient(state, {
    redirectUris: [updatedRedirectUri],
  });

  await assertAuthorizationRequestRejected(request.agent(app), {
    client_id: "demo-site",
    redirect_uri: TEST_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile",
    state: "stale-redirect-uri",
    nonce: "stale-redirect-uri-nonce",
    code_challenge: sha256Base64Url(
      "stale-redirect-uri-verifier-stale-redirect-uri-verifier",
    ),
    code_challenge_method: "S256",
  });

  const authorize = await request(app)
    .get("/auth")
    .query({
      client_id: "demo-site",
      redirect_uri: updatedRedirectUri,
      response_type: "code",
      scope: "openid profile",
      prompt: "consent",
      state: "updated-redirect-uri",
      nonce: "updated-redirect-uri-nonce",
      code_challenge: sha256Base64Url(
        "updated-redirect-uri-verifier-updated-redirect-uri-verifier",
      ),
      code_challenge_method: "S256",
    });
  assert.ok(authorize.status === 302 || authorize.status === 303);
  assert.match(authorize.headers["location"] as string, /^\/interaction\//);
  await state.persistence.runtime.close();
});

test("client secret rotation honors dual-secret grace and expiry without restart", async () => {
  const { app, state } = await createTestApp();
  const beforeRotation = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: "missing-token-before-rotation",
    });
  assert.notEqual(beforeRotation.body.error, "invalid_client");

  const rotatedSecret = `rotated-${Date.now()}-secret`;
  const management = new ClientManagementService(
    state.persistence.clients,
    new ProjectAccessService(state.persistence.projects),
    "test",
    {
      createSecret: () => rotatedSecret,
    },
  );
  const managed =
    await state.persistence.clients.findManagedOidcClient("demo-site");
  await management.rotateSecret(
    { subjectId: "subj_admin", isAdmin: true },
    SYSTEM_PROJECT_ID,
    "demo-site",
    { clientVersion: managed!.client.version, gracePeriodSeconds: 1 },
  );

  const oldSecret = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: "missing-token-old-secret",
    });
  assert.notEqual(oldSecret.body.error, "invalid_client");

  const newSecret = await request(app)
    .post("/token")
    .auth("demo-site", rotatedSecret, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: "missing-token-new-secret",
    });
  assert.notEqual(newSecret.body.error, "invalid_client");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const expiredOldSecret = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: "missing-token-expired-old-secret",
    });
  assert.equal(expiredOldSecret.body.error, "invalid_client");
  await state.persistence.runtime.close();
});

test("signing key refresh updates jwks within configured interval", async () => {
  const { app, state } = await createTestApp({
    OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS: "1",
  });
  const initialJwks = await request(app).get("/jwks");
  assert.equal(initialJwks.status, 200);
  const initialKids = new Set(
    (initialJwks.body.keys as Array<{ kid?: string }>)
      .map((key) => key.kid)
      .filter(Boolean),
  );
  const addedKey = await generateSigningKey(state.persistence);

  await waitFor(async () => {
    const jwks = await request(app).get("/jwks");
    const kids = (jwks.body.keys as Array<{ kid?: string }>).map(
      (key) => key.kid,
    );
    return kids.includes(addedKey.kid);
  });

  await state.persistence.signingKeys.upsertSigningKey({
    ...addedKey,
    status: "retired",
    retiredAt: new Date().toISOString(),
  });

  await waitFor(async () => {
    const jwks = await request(app).get("/jwks");
    const kids = (jwks.body.keys as Array<{ kid?: string }>).map(
      (key) => key.kid,
    );
    const keepsExisting = [...initialKids].every((kid) => kids.includes(kid));
    return keepsExisting && !kids.includes(addedKey.kid);
  });

  await state.persistence.runtime.close();
});
