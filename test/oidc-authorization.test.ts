import { test } from "vite-plus/test";
import {
  ClientManagementService,
  Pool,
  ProjectAccessService,
  SYSTEM_PROJECT_ID,
  TEST_DEMO_CLIENT_SECRET,
  TEST_LOGIN_ACCOUNT,
  TEST_LOGIN_PASSWORD,
  TEST_POST_LOGOUT_REDIRECT_URI,
  TEST_REDIRECT_URI,
  assert,
  assertLogoutPageSecurityHeaders,
  authorizeThroughProfile,
  createHmac,
  createTestApp,
  decodeJwtPayload,
  disableDemoAutoConsent,
  extractCsrf,
  extractFormAction,
  extractHiddenFormInputs,
  followToConsentPage,
  followToRedirectUriOrigin,
  getSetCookieValue,
  normalizeActionPath,
  openLoginInteraction,
  randomUUID,
  request,
  runAuthorizationFlow,
  runAuthorizationToConsent,
  sendEmailVerificationCode,
  sha256Base64Url,
} from "./oidc-op.helpers.js";

test("authorization code flow, userinfo, refresh rotation, and session reuse work", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);

  const { code, codeVerifier } = await runAuthorizationFlow(
    agent,
    emailSender,
    "state-1",
  );

  const token = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: codeVerifier,
    });
  assert.equal(token.status, 200);
  assert.equal(typeof token.body.id_token, "string");
  assert.equal(typeof token.body.access_token, "string");
  assert.equal(typeof token.body.refresh_token, "string");

  const userinfo = await request(app)
    .get("/userinfo")
    .set("Authorization", `Bearer ${token.body.access_token as string}`);
  assert.equal(userinfo.status, 200);
  const principal = await state.persistence.identity.findPrincipalBySubjectId(
    userinfo.body.sub as string,
  );
  assert.ok(principal);
  assert.equal(principal.schoolUid, TEST_LOGIN_ACCOUNT);
  assert.equal(userinfo.body.name, `User-${TEST_LOGIN_ACCOUNT}`);
  assert.equal(userinfo.body.email, "demo@example.com");
  assert.equal(userinfo.body.email_verified, true);
  assert.equal(userinfo.body.status, "active");
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
    code_challenge: sha256Base64Url(
      "another-verifier-another-verifier-another-verifier",
    ),
    code_challenge_method: "S256",
  });
  assert.ok(secondAuthorize.status === 302 || secondAuthorize.status === 303);
  const secondRedirect = await followToRedirectUriOrigin(
    agent,
    secondAuthorize,
    TEST_REDIRECT_URI,
  );
  assert.match(secondRedirect, /^http:\/\/localhost:3002\/demo\/callback\?/);

  const rotated = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token as string,
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
      refresh_token: token.body.refresh_token as string,
    });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, "invalid_grant");

  const management = new ClientManagementService(
    state.persistence.clients,
    new ProjectAccessService(state.persistence.projects),
    "test",
  );
  const managed =
    await state.persistence.clients.findManagedOidcClient("demo-site");
  await management.revokeAuthorizations(
    { subjectId: "subj_admin", isAdmin: true },
    SYSTEM_PROJECT_ID,
    "demo-site",
    { clientVersion: managed!.client.version },
  );
  const revokedAccess = await request(app)
    .get("/userinfo")
    .set("Authorization", `Bearer ${token.body.access_token as string}`);
  assert.equal(revokedAccess.status, 401);
  const revokedRefresh = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: rotated.body.refresh_token as string,
    });
  assert.equal(revokedRefresh.status, 400);
  assert.equal(revokedRefresh.body.error, "invalid_grant");

  await state.persistence.runtime.close();
});

test("authorization code can be consumed by only one concurrent request", async () => {
  const { app, state, emailSender } = await createTestApp({
    OIDC_TOKEN_RATE_LIMIT_MAX: "20",
  });
  const agent = request.agent(app);
  const { code, codeVerifier } = await runAuthorizationFlow(
    agent,
    emailSender,
    "concurrent-code-consumption",
  );

  const responses = await Promise.all(
    Array.from({ length: 10 }, () =>
      request(app)
        .post("/token")
        .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
        .type("form")
        .send({
          grant_type: "authorization_code",
          code,
          redirect_uri: TEST_REDIRECT_URI,
          code_verifier: codeVerifier,
        }),
    ),
  );

  assert.equal(
    responses.filter((response) => response.status === 200).length,
    1,
  );
  assert.equal(
    responses.filter(
      (response) =>
        response.status === 400 && response.body.error === "invalid_grant",
    ).length,
    9,
  );
  await state.persistence.runtime.close();
});

test(
  "PostgreSQL application flow stores HMAC client indexes and enforces authorization generations",
  { skip: !process.env["TEST_DATABASE_URL"] },
  async () => {
    const databaseUrl = process.env["TEST_DATABASE_URL"]!;
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `oidc_app_${randomUUID().replaceAll("-", "_")}`;
    await adminPool.query(`create schema "${schema}"`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    let state: Awaited<ReturnType<typeof createTestApp>>["state"] | undefined;
    try {
      const created = await createTestApp({
        DATABASE_URL: scopedUrl.toString(),
        OIDC_ALLOW_IN_MEMORY_STORE: "false",
      });
      state = created.state;
      assert.equal(state.persistence.runtime.hasDatabase(), true);
      const agent = request.agent(created.app);
      const { code, codeVerifier } = await runAuthorizationFlow(
        agent,
        created.emailSender,
        "postgres-generation-state",
      );
      const token = await request(created.app)
        .post("/token")
        .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
        .type("form")
        .send({
          grant_type: "authorization_code",
          code,
          redirect_uri: TEST_REDIRECT_URI,
          code_verifier: codeVerifier,
        });
      assert.equal(token.status, 200);
      const artifactRows = await adminPool.query(
        `select client_id_hash, authorization_generation
         from "${schema}".oidc_artifacts
         where kind in ('AuthorizationCode', 'AccessToken', 'RefreshToken', 'Grant')`,
      );
      assert.ok(artifactRows.rowCount && artifactRows.rowCount >= 3);
      const expectedHash = createHmac("sha256", "test-oidc-artifact-secret")
        .update("demo-site")
        .digest("hex");
      assert.ok(
        artifactRows.rows.every(
          (row) =>
            row["client_id_hash"] === expectedHash &&
            row["client_id_hash"] !== "demo-site" &&
            Number(row["authorization_generation"]) === 1,
        ),
      );

      const managed =
        await state.persistence.clients.findManagedOidcClient("demo-site");
      const management = new ClientManagementService(
        state.persistence.clients,
        new ProjectAccessService(state.persistence.projects),
        "test",
      );
      let releaseLateIssue!: () => void;
      const revocationBarrier = new Promise<void>((resolve) => {
        releaseLateIssue = resolve;
      });
      const lateIssue = (async () => {
        await revocationBarrier;
        await state!.persistence.artifacts.upsertArtifact(
          "AccessToken:late-postgres-token",
          "AccessToken",
          { clientId: "demo-site", accountId: "late-subject" },
          300,
          1,
        );
      })();
      await management.revokeAuthorizations(
        { subjectId: "subj_admin", isAdmin: true },
        SYSTEM_PROJECT_ID,
        "demo-site",
        { clientVersion: managed!.client.version },
      );
      releaseLateIssue();
      await lateIssue;
      assert.equal(
        await state.persistence.artifacts.findArtifact(
          "AccessToken:late-postgres-token",
        ),
        undefined,
      );
      const revokedAccess = await request(created.app)
        .get("/userinfo")
        .set("Authorization", `Bearer ${token.body.access_token as string}`);
      assert.equal(revokedAccess.status, 401);
      const revokedRefresh = await request(created.app)
        .post("/token")
        .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
        .type("form")
        .send({
          grant_type: "refresh_token",
          refresh_token: token.body.refresh_token as string,
        });
      assert.equal(revokedRefresh.status, 400);
      assert.equal(revokedRefresh.body.error, "invalid_grant");

      const sessionReuse = await agent.get("/auth").query({
        client_id: "demo-site",
        redirect_uri: TEST_REDIRECT_URI,
        response_type: "code",
        scope: "openid profile",
        prompt: "none",
        state: "postgres-session-preserved",
        nonce: "postgres-session-preserved",
        code_challenge: sha256Base64Url(
          "postgres-session-verifier-postgres-session-verifier",
        ),
        code_challenge_method: "S256",
      });
      assert.ok(sessionReuse.status === 302 || sessionReuse.status === 303);
      const redirect = await followToRedirectUriOrigin(
        agent,
        sessionReuse,
        TEST_REDIRECT_URI,
      );
      assert.equal(
        new URL(redirect).searchParams.get("state"),
        "postgres-session-preserved",
      );
    } finally {
      await state?.persistence.runtime.close();
      await adminPool.query(`drop schema if exists "${schema}" cascade`);
      await adminPool.end();
    }
  },
);

test("userinfo normalizes legacy active_student status to active", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);

  const { code, codeVerifier } = await runAuthorizationFlow(
    agent,
    emailSender,
    "state-legacy-status",
  );

  const token = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "authorization_code",
      code,
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: codeVerifier,
    });
  assert.equal(token.status, 200);
  assert.equal(typeof token.body.access_token, "string");

  const identity = await state.persistence.identity.findIdentity(
    "mock",
    `mock:${TEST_LOGIN_ACCOUNT}`,
  );
  assert.ok(identity);
  const principal = await state.persistence.identity.findPrincipalBySubjectId(
    identity.subjectId,
  );
  assert.ok(principal);
  await state.persistence.identity.updateIdentity(
    principal.identitySource,
    principal.identityKey,
    {
      schoolUid: principal.schoolUid,
      currentStudentStatus: "active_student" as any,
      school: principal.school,
      updatedAt: new Date().toISOString(),
    },
  );

  const userinfo = await request(app)
    .get("/userinfo")
    .set("Authorization", `Bearer ${token.body.access_token as string}`);
  assert.equal(userinfo.status, 200);
  assert.equal(userinfo.body.status, "active");
  assert.equal(Object.hasOwn(userinfo.body as object, "school"), false);
  assert.equal(Object.hasOwn(userinfo.body as object, "student_status"), false);

  await state.persistence.runtime.close();
});

test("unverified email stays in profile but is omitted from oidc claims when verification is disabled", async () => {
  const { app, state } = await createTestApp({
    OIDC_EMAIL_VERIFICATION_ENABLED: "false",
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
    code_challenge_method: "S256",
  });
  assert.ok(authorize.status === 302 || authorize.status === 303);
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
  assert.equal(login.status, 302);
  assert.match(
    login.headers["location"] as string,
    /\/interaction\/.+\/profile/,
  );

  const profileLocation = login.headers["location"] as string;
  const profilePage = await agent.get(profileLocation);
  assert.equal(profilePage.status, 200);
  const profileCsrf = extractCsrf(profilePage.text);
  const chosenEmail = "victim@example.com";
  const submitProfile = await agent.post(profileLocation).type("form").send({
    csrf: profileCsrf,
    email: chosenEmail,
  });
  const redirectLocation = await followToRedirectUriOrigin(
    agent,
    submitProfile,
    TEST_REDIRECT_URI,
  );
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
      code_verifier: verifier,
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

  const principal = await state.persistence.identity.findPrincipalBySubjectId(
    userinfo.body.sub as string,
  );
  assert.ok(principal);
  assert.equal(principal.email, chosenEmail);
  assert.equal(principal.emailVerified, false);

  await state.persistence.runtime.close();
});

test("rp initiated logout clears the HttpOnly interaction csrf nonce cookie", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { loginPage } = await openLoginInteraction(agent, "logout-csrf-nonce");
  assert.ok(getSetCookieValue(loginPage, "op_csrf_nonce"));

  const logoutPage = await agent.get("/session/end").query({
    client_id: "demo-site",
    post_logout_redirect_uri: TEST_POST_LOGOUT_REDIRECT_URI,
  });
  const clearHeader = (
    logoutPage.headers["set-cookie"] as string[] | undefined
  )?.find((header) => header.startsWith("op_csrf_nonce="));
  assert.ok(clearHeader);
  assert.match(clearHeader, /HttpOnly/i);
  assert.match(clearHeader, /Expires=/i);

  await state.persistence.runtime.close();
});

test("rp initiated logout redirects to post_logout_redirect_uri", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);
  await runAuthorizationFlow(agent, emailSender, "logout-state-session");

  const logoutPage = await agent.get("/session/end").query({
    client_id: "demo-site",
    post_logout_redirect_uri: TEST_POST_LOGOUT_REDIRECT_URI,
    state: "logout-state-1",
  });
  assert.equal(logoutPage.status, 200);
  assertLogoutPageSecurityHeaders(logoutPage);
  assert.match(logoutPage.text, /确认退出登录/);
  assert.doesNotMatch(logoutPage.text, /logout-auto-submit/);
  assert.doesNotMatch(logoutPage.text, /<script/i);
  assert.equal(logoutPage.text.match(/name="logout"/g)?.length, 1);
  const formAction = extractFormAction(logoutPage.text);
  assert.equal(typeof formAction, "string");

  const hiddenFields = extractHiddenFormInputs(logoutPage.text);
  const submit = await agent
    .post(normalizeActionPath(formAction as string))
    .type("form")
    .send(hiddenFields);
  const externalRedirect = await followToRedirectUriOrigin(
    agent,
    submit,
    TEST_POST_LOGOUT_REDIRECT_URI,
  );
  const redirect = new URL(externalRedirect);
  assert.equal(
    redirect.origin + redirect.pathname,
    TEST_POST_LOGOUT_REDIRECT_URI,
  );
  assert.equal(redirect.searchParams.get("state"), "logout-state-1");

  await state.persistence.runtime.close();
});

test("rp initiated logout shows success page when no redirect uri is provided", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);
  await runAuthorizationFlow(agent, emailSender, "logout-success-session");

  const logoutPage = await agent.get("/session/end").query({
    client_id: "demo-site",
  });
  assert.equal(logoutPage.status, 200);
  assertLogoutPageSecurityHeaders(logoutPage);
  assert.match(logoutPage.text, /确认退出登录/);
  assert.doesNotMatch(logoutPage.text, /logout-auto-submit/);
  assert.doesNotMatch(logoutPage.text, /<script/i);
  assert.equal(logoutPage.text.match(/name="logout"/g)?.length, 1);
  const formAction = extractFormAction(logoutPage.text);
  assert.equal(typeof formAction, "string");

  const hiddenFields = extractHiddenFormInputs(logoutPage.text);
  const submit = await agent
    .post(normalizeActionPath(formAction as string))
    .type("form")
    .send(hiddenFields);
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

  await state.persistence.runtime.close();
});

test("rp initiated logout rejects unregistered post_logout_redirect_uri", async () => {
  const { app, state } = await createTestApp();
  const response = await request(app).get("/session/end").query({
    client_id: "demo-site",
    post_logout_redirect_uri: "http://localhost:3002/demo",
  });
  assert.equal(response.status, 400);
  await state.persistence.runtime.close();
});

test("non-whitelisted clients require explicit consent approval", async () => {
  const { app, state, emailSender } = await createTestApp();
  await disableDemoAutoConsent(state);
  const agent = request.agent(app);
  const { consentAction, consentCsrf } = await runAuthorizationToConsent(
    agent,
    emailSender,
    "manual-state-allow",
  );

  const approved = await agent
    .post(consentAction)
    .type("form")
    .send({ csrf: consentCsrf, action: "approve" });
  const callbackRedirect = await followToRedirectUriOrigin(
    agent,
    approved,
    TEST_REDIRECT_URI,
  );
  const callbackUrl = new URL(callbackRedirect);
  assert.equal(callbackUrl.origin + callbackUrl.pathname, TEST_REDIRECT_URI);
  assert.equal(callbackUrl.searchParams.get("state"), "manual-state-allow");
  assert.equal(typeof callbackUrl.searchParams.get("code"), "string");

  await state.persistence.runtime.close();
});

test("consent page disables duplicate submissions while completing authorization", async () => {
  const { app, state, emailSender } = await createTestApp();
  await disableDemoAutoConsent(state);
  const agent = request.agent(app);
  const { response } = await authorizeThroughProfile(
    agent,
    emailSender,
    "manual-state-consent-pending",
  );
  const consentPage = await followToConsentPage(agent, response);

  assert.match(consentPage, /data-consent-form/);
  assert.match(consentPage, /data-consent-submit/);
  assert.match(consentPage, /data-consent-action/);
  assert.match(consentPage, /正在完成授权请求，请稍候。/);
  assert.match(consentPage, /setAttribute\("name", "action"\)/);
  assert.match(consentPage, /setAttribute\("value", action\)/);
  assert.match(consentPage, /event\.preventDefault\(\)/);
  assert.match(consentPage, /setAttribute\("disabled", "disabled"\)/);

  await state.persistence.runtime.close();
});

test("stale interaction requests return an expired-flow page instead of server_error", async () => {
  const { app, state, emailSender } = await createTestApp();
  await disableDemoAutoConsent(state);
  const agent = request.agent(app);
  const { consentAction, consentCsrf } = await runAuthorizationToConsent(
    agent,
    emailSender,
    "manual-state-stale-interaction",
  );

  const approved = await agent
    .post(consentAction)
    .type("form")
    .send({ csrf: consentCsrf, action: "approve" });
  const callbackRedirect = await followToRedirectUriOrigin(
    agent,
    approved,
    TEST_REDIRECT_URI,
  );
  assert.equal(
    new URL(callbackRedirect).searchParams.get("state"),
    "manual-state-stale-interaction",
  );

  const staleGet = await agent.get(consentAction.replace(/\/consent$/, ""));
  assert.equal(staleGet.status, 400);
  assert.match(staleGet.text, /登录流程已过期/);
  assert.doesNotMatch(staleGet.text, /server_error/);

  const stalePost = await agent
    .post(consentAction)
    .type("form")
    .send({ csrf: consentCsrf, action: "approve" });
  assert.equal(stalePost.status, 400);
  assert.match(stalePost.text, /登录流程已过期/);
  assert.doesNotMatch(stalePost.text, /server_error/);

  await state.persistence.runtime.close();
});

test("profile routes reject requests without the interaction session cookie", async () => {
  const { app, state, emailSender } = await createTestApp();
  const victim = request.agent(app);
  const { profileLocation } = await sendEmailVerificationCode(
    victim,
    "manual-state-profile-binding",
    "victim@example.com",
  );

  // A fresh client that knows only the interaction uid (leaked via the URL,
  // Referer, browser history, or access logs) but holds no _interaction cookie
  // must not reach the profile page or trigger any side effects.
  const attacker = request(app);
  const attackerGet = await attacker.get(profileLocation);
  assert.equal(attackerGet.status, 400);
  assert.match(attackerGet.text, /登录流程已过期/);
  assert.doesNotMatch(attackerGet.text, /name="csrf"/);

  const attackerPost = await attacker.post(profileLocation).type("form").send({
    csrf: "forged-token",
    action: "send_code",
    email: "attacker@evil.com",
  });
  assert.equal(attackerPost.status, 400);
  assert.match(attackerPost.text, /登录流程已过期/);

  // No verification email was ever dispatched to the attacker-chosen address.
  assert.equal(
    emailSender.sentVerifications.some(
      (entry) => entry.to === "attacker@evil.com",
    ),
    false,
  );

  await state.persistence.runtime.close();
});
