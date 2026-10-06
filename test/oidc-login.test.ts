import { test } from "vite-plus/test";
import {
  MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD,
  RateLimitUnavailableError,
  TEST_LOGIN_ACCOUNT,
  TEST_LOGIN_PASSWORD,
  TEST_REDIRECT_URI,
  TEST_WRONG_LOGIN_PASSWORD,
  assert,
  createTestApp,
  disableDemoAutoConsent,
  extractCsrf,
  followToRedirectUriOrigin,
  openLoginInteraction,
  request,
  runAuthorizationToConsent,
  sha256Base64Url,
  withHeaders,
} from "./oidc-op.helpers.js";

test("login without email scope skips profile completion", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "login-without-email-scope",
    undefined,
    "openid profile",
  );
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
  const callback = await followToRedirectUriOrigin(
    agent,
    login,
    TEST_REDIRECT_URI,
  );
  const callbackUrl = new URL(callback);
  assert.equal(
    callbackUrl.searchParams.get("state"),
    "login-without-email-scope",
  );
  assert.equal(typeof callbackUrl.searchParams.get("code"), "string");
  assert.equal(emailSender.sentVerifications.length, 0);

  await state.persistence.runtime.close();
});

test("interactive login treats upstream outages as retryable 503 without consuming the failure budget", async () => {
  const { app, state } = await createTestApp({
    // Isolate the failure-bucket behavior from the separate attempt limiter.
    OIDC_LOGIN_RATE_LIMIT_MAX: "100",
  });
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "manual-state-upstream-outage",
  );

  // Well above the default failure limit (5): if outages were counted as
  // credential failures, later attempts would return 429, not 503.
  const attempts = 8;
  for (let index = 0; index < attempts; index += 1) {
    const page = index === 0 ? loginPage : await agent.get(interactionLocation);
    const csrf = extractCsrf(page.text);
    const login = await agent
      .post(`${interactionLocation}/login`)
      .type("form")
      .send({
        csrf,
        account: TEST_LOGIN_ACCOUNT,
        password: MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD,
      });
    assert.equal(login.status, 503);
    assert.equal(login.headers["retry-after"], "60");
  }

  await state.persistence.runtime.close();
});

test("interactive login upstream outage rolls back consumed attempt rate-limit budget", async () => {
  const { app, state } = await createTestApp({
    OIDC_LOGIN_RATE_LIMIT_MAX: "1",
  });
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "manual-state-upstream-attempt-limit",
  );

  for (let index = 0; index < 2; index += 1) {
    const page = index === 0 ? loginPage : await agent.get(interactionLocation);
    const csrf = extractCsrf(page.text);
    const login = await agent
      .post(`${interactionLocation}/login`)
      .type("form")
      .send({
        csrf,
        account: TEST_LOGIN_ACCOUNT,
        password: MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD,
      });
    assert.equal(login.status, 503);
    assert.equal(login.headers["retry-after"], "60");
  }

  await state.persistence.runtime.close();
});

test("interactive login rolls back attempt budget when failure rate limiter is unavailable", async () => {
  const { app, state } = await createTestApp({
    OIDC_LOGIN_RATE_LIMIT_MAX: "2",
  });
  const originalConsume = state.rateLimitService.consume.bind(
    state.rateLimitService,
  );
  let failFailureConsume = false;
  state.rateLimitService.consume = async (key, max, windowSeconds) => {
    if (failFailureConsume && key.includes(":failure:")) {
      throw new RateLimitUnavailableError();
    }
    return originalConsume(key, max, windowSeconds);
  };
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "login-failure-rate-limit-outage",
  );

  try {
    const first = await agent
      .post(`${interactionLocation}/login`)
      .type("form")
      .send({
        csrf: extractCsrf(loginPage.text),
        account: TEST_LOGIN_ACCOUNT,
        password: TEST_WRONG_LOGIN_PASSWORD,
      });
    assert.equal(first.status, 401);

    failFailureConsume = true;
    const secondPage = await agent.get(interactionLocation);
    const second = await agent
      .post(`${interactionLocation}/login`)
      .type("form")
      .send({
        csrf: extractCsrf(secondPage.text),
        account: TEST_LOGIN_ACCOUNT,
        password: TEST_WRONG_LOGIN_PASSWORD,
      });
    assert.equal(second.status, 503);
    assert.equal(second.headers["retry-after"], "60");

    failFailureConsume = false;
    const thirdPage = await agent.get(interactionLocation);
    const third = await agent
      .post(`${interactionLocation}/login`)
      .type("form")
      .send({
        csrf: extractCsrf(thirdPage.text),
        account: TEST_LOGIN_ACCOUNT,
        password: TEST_WRONG_LOGIN_PASSWORD,
      });
    assert.equal(third.status, 401);
  } finally {
    state.rateLimitService.consume = originalConsume;
    await state.persistence.runtime.close();
  }
});

test("interactive login attempt rate limit does not bleed across dimensions on deny", async () => {
  const { app, state } = await createTestApp({
    OIDC_LOGIN_RATE_LIMIT_MAX: "1",
  });
  const originalConsume = state.rateLimitService.consume.bind(
    state.rateLimitService,
  );
  let denyIpAttempt = false;
  state.rateLimitService.consume = async (key, max, windowSeconds) => {
    if (denyIpAttempt && key.includes(":attempt:ip:")) {
      return { allowed: false, retryAfterSeconds: 60 };
    }
    return originalConsume(key, max, windowSeconds);
  };
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "login-attempt-dimension-bleed",
  );

  try {
    denyIpAttempt = true;
    const blocked = await agent
      .post(`${interactionLocation}/login`)
      .type("form")
      .send({
        csrf: extractCsrf(loginPage.text),
        account: TEST_LOGIN_ACCOUNT,
        password: TEST_WRONG_LOGIN_PASSWORD,
      });
    assert.equal(blocked.status, 429);

    denyIpAttempt = false;
    const page = await agent.get(interactionLocation);
    const retry = await agent
      .post(`${interactionLocation}/login`)
      .type("form")
      .send({
        csrf: extractCsrf(page.text),
        account: TEST_LOGIN_ACCOUNT,
        password: TEST_WRONG_LOGIN_PASSWORD,
      });
    assert.equal(retry.status, 401);
  } finally {
    state.rateLimitService.consume = originalConsume;
    await state.persistence.runtime.close();
  }
});

test("interactive login attempt rate limit outage rolls back partial consume", async () => {
  const { app, state } = await createTestApp({
    OIDC_LOGIN_RATE_LIMIT_MAX: "1",
  });
  const originalConsume = state.rateLimitService.consume.bind(
    state.rateLimitService,
  );
  let failAttemptIp = false;
  state.rateLimitService.consume = async (key, max, windowSeconds) => {
    if (failAttemptIp && key.includes(":attempt:ip:")) {
      throw new RateLimitUnavailableError();
    }
    return originalConsume(key, max, windowSeconds);
  };
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "login-attempt-partial-outage",
  );

  try {
    failAttemptIp = true;
    const outage = await agent
      .post(`${interactionLocation}/login`)
      .type("form")
      .send({
        csrf: extractCsrf(loginPage.text),
        account: TEST_LOGIN_ACCOUNT,
        password: TEST_WRONG_LOGIN_PASSWORD,
      });
    assert.equal(outage.status, 503);
    assert.equal(outage.headers["retry-after"], "60");

    failAttemptIp = false;
    const page = await agent.get(interactionLocation);
    const retry = await agent
      .post(`${interactionLocation}/login`)
      .type("form")
      .send({
        csrf: extractCsrf(page.text),
        account: TEST_LOGIN_ACCOUNT,
        password: TEST_WRONG_LOGIN_PASSWORD,
      });
    assert.equal(retry.status, 401);
  } finally {
    state.rateLimitService.consume = originalConsume;
    await state.persistence.runtime.close();
  }
});

test("consent denial returns access_denied to client redirect uri", async () => {
  const { app, state, emailSender } = await createTestApp();
  await disableDemoAutoConsent(state);
  const agent = request.agent(app);
  const { consentAction, consentCsrf } = await runAuthorizationToConsent(
    agent,
    emailSender,
    "manual-state-deny",
  );

  const denied = await agent
    .post(consentAction)
    .type("form")
    .send({ csrf: consentCsrf, action: "deny" });
  const denyRedirect = await followToRedirectUriOrigin(
    agent,
    denied,
    TEST_REDIRECT_URI,
  );
  const denyUrl = new URL(denyRedirect);
  assert.equal(denyUrl.origin + denyUrl.pathname, TEST_REDIRECT_URI);
  assert.equal(denyUrl.searchParams.get("state"), "manual-state-deny");
  assert.equal(denyUrl.searchParams.get("error"), "access_denied");
  assert.equal(denyUrl.searchParams.get("code"), null);

  await state.persistence.runtime.close();
});

test("prompt=none does not silently grant newly requested scopes", async () => {
  const { app, state, emailSender } = await createTestApp();
  await disableDemoAutoConsent(state);
  const agent = request.agent(app);
  const { consentAction, consentCsrf } = await runAuthorizationToConsent(
    agent,
    emailSender,
    "manual-state-initial",
    "openid profile",
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
    code_challenge: sha256Base64Url(
      "manual-verifier-second-manual-verifier-second",
    ),
    code_challenge_method: "S256",
  });
  const secondRedirect = await followToRedirectUriOrigin(
    agent,
    secondAuthorize,
    TEST_REDIRECT_URI,
  );
  const secondUrl = new URL(secondRedirect);
  assert.equal(secondUrl.origin + secondUrl.pathname, TEST_REDIRECT_URI);
  assert.equal(secondUrl.searchParams.get("state"), "manual-state-none");
  assert.ok(
    ["consent_required", "interaction_required"].includes(
      secondUrl.searchParams.get("error") ?? "",
    ),
  );
  assert.equal(secondUrl.searchParams.get("code"), null);

  await state.persistence.runtime.close();
});

test("interactive login failure does not expose internal error details", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { interactionLocation, loginPage } = await openLoginInteraction(
    agent,
    "login-fail-state",
  );
  const csrf = extractCsrf(loginPage.text);
  const login = await agent
    .post(`${interactionLocation}/login`)
    .type("form")
    .send({
      csrf,
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  assert.equal(login.status, 401);
  assert.match(login.text, /登录失败，请检查账号或密码后重试/);
  assert.doesNotMatch(login.text, /IdentityCoreError|invalid credentials/i);
  await state.persistence.runtime.close();
});

test("interactive login page shows a pending state and prevents duplicate submits", async () => {
  const { app, state } = await createTestApp();
  const agent = request.agent(app);
  const { loginPage } = await openLoginInteraction(
    agent,
    "login-pending-ui-state",
  );

  assert.match(loginPage.text, /data-login-form/);
  assert.match(loginPage.text, /data-login-submit/);
  assert.match(loginPage.text, /正在登录/);
  assert.match(loginPage.text, /正在连接学校统一身份认证，请稍候。/);
  assert.match(loginPage.text, /event\.preventDefault\(\)/);
  assert.match(loginPage.text, /setAttribute\("readonly", "readonly"\)/);
  assert.match(loginPage.text, /setAttribute\("disabled", "disabled"\)/);

  await state.persistence.runtime.close();
});

test("interactive login failure rate limit blocks repeated attempts for the same account across trusted proxy ips", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_LOGIN_FAILURE_LIMIT: "2",
  });
  const agent = request.agent(app);
  const account = "rate-limit-account";

  const firstInteraction = await openLoginInteraction(
    agent,
    "login-account-limit-1",
    {
      "X-Forwarded-For": "198.51.100.1",
    },
  );
  const first = await withHeaders(
    agent.post(`${firstInteraction.interactionLocation}/login`),
    {
      "X-Forwarded-For": "198.51.100.1",
    },
  )
    .type("form")
    .send({
      csrf: extractCsrf(firstInteraction.loginPage.text),
      account,
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  const secondInteraction = await openLoginInteraction(
    agent,
    "login-account-limit-2",
    {
      "X-Forwarded-For": "198.51.100.2",
    },
  );
  const second = await withHeaders(
    agent.post(`${secondInteraction.interactionLocation}/login`),
    {
      "X-Forwarded-For": "198.51.100.2",
    },
  )
    .type("form")
    .send({
      csrf: extractCsrf(secondInteraction.loginPage.text),
      account,
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  const thirdInteraction = await openLoginInteraction(
    agent,
    "login-account-limit-3",
    {
      "X-Forwarded-For": "198.51.100.3",
    },
  );
  const third = await withHeaders(
    agent.post(`${thirdInteraction.interactionLocation}/login`),
    {
      "X-Forwarded-For": "198.51.100.3",
    },
  )
    .type("form")
    .send({
      csrf: extractCsrf(thirdInteraction.loginPage.text),
      account,
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(third.status, 429);
  await state.persistence.runtime.close();
});

test("interactive login failure rate limit blocks sprays from the same trusted proxy ip across accounts", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_LOGIN_FAILURE_LIMIT: "2",
  });
  const agent = request.agent(app);
  const headers = { "X-Forwarded-For": "198.51.100.10" };

  const firstInteraction = await openLoginInteraction(
    agent,
    "login-ip-limit-1",
    headers,
  );
  const first = await withHeaders(
    agent.post(`${firstInteraction.interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: extractCsrf(firstInteraction.loginPage.text),
      account: "spray-account-a",
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  const secondInteraction = await openLoginInteraction(
    agent,
    "login-ip-limit-2",
    headers,
  );
  const second = await withHeaders(
    agent.post(`${secondInteraction.interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: extractCsrf(secondInteraction.loginPage.text),
      account: "spray-account-b",
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  const thirdInteraction = await openLoginInteraction(
    agent,
    "login-ip-limit-3",
    headers,
  );
  const third = await withHeaders(
    agent.post(`${thirdInteraction.interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: extractCsrf(thirdInteraction.loginPage.text),
      account: "spray-account-c",
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(third.status, 429);
  await state.persistence.runtime.close();
});

test("interactive login failure rate limit blocks repeated attempts for the same account and trusted proxy ip", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_LOGIN_FAILURE_LIMIT: "1",
  });
  const agent = request.agent(app);
  const headers = { "X-Forwarded-For": "198.51.100.20" };

  const firstInteraction = await openLoginInteraction(
    agent,
    "login-account-ip-limit-1",
    headers,
  );
  const first = await withHeaders(
    agent.post(`${firstInteraction.interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: extractCsrf(firstInteraction.loginPage.text),
      account: "combo-account",
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  const secondInteraction = await openLoginInteraction(
    agent,
    "login-account-ip-limit-2",
    headers,
  );
  const second = await withHeaders(
    agent.post(`${secondInteraction.interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: extractCsrf(secondInteraction.loginPage.text),
      account: "combo-account",
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  assert.equal(first.status, 401);
  assert.equal(second.status, 429);
  await state.persistence.runtime.close();
});

test("interactive login success clears account failure buckets but keeps shared ip protection", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_LOGIN_FAILURE_LIMIT: "2",
  });
  const agent = request.agent(app);
  const headers = { "X-Forwarded-For": "198.51.100.30" };

  const firstInteraction = await openLoginInteraction(
    agent,
    "login-reset-1",
    headers,
  );
  const first = await withHeaders(
    agent.post(`${firstInteraction.interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: extractCsrf(firstInteraction.loginPage.text),
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  const secondInteraction = await openLoginInteraction(
    agent,
    "login-reset-2",
    headers,
  );
  const second = await withHeaders(
    agent.post(`${secondInteraction.interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: extractCsrf(secondInteraction.loginPage.text),
      account: "other-account-before-success",
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  const successInteraction = await openLoginInteraction(
    agent,
    "login-reset-3",
    headers,
  );
  const success = await withHeaders(
    agent.post(`${successInteraction.interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: extractCsrf(successInteraction.loginPage.text),
      account: TEST_LOGIN_ACCOUNT,
      password: TEST_LOGIN_PASSWORD,
    });

  const blockedInteraction = await openLoginInteraction(
    agent,
    "login-reset-4",
    headers,
  );
  const blocked = await withHeaders(
    agent.post(`${blockedInteraction.interactionLocation}/login`),
    headers,
  )
    .type("form")
    .send({
      csrf: extractCsrf(blockedInteraction.loginPage.text),
      account: "other-account-after-success",
      password: TEST_WRONG_LOGIN_PASSWORD,
    });

  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(success.status, 302);
  assert.equal(blocked.status, 429);
  await state.persistence.runtime.close();
});
