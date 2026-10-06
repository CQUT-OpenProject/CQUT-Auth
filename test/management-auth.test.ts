import { test } from "vite-plus/test";
import {
  MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD,
  RateLimitUnavailableError,
  assert,
  createApp,
  getSetCookieValue,
  login,
  request,
  seedAdmin,
} from "./management-api.helpers.js";

test("management logout clears the HttpOnly csrf nonce cookie", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const agent = request.agent(app);
    const context = await agent.get("/api/management/auth/context");
    assert.ok(getSetCookieValue(context, "cqut_manage_csrf"));
    const signedIn = await login(agent, "admin-account");
    const logout = await agent
      .post("/api/management/auth/logout")
      .set("X-CSRF-Token", signedIn.body.csrfToken);
    assert.equal(logout.status, 204);
    const clearHeader = (
      logout.headers["set-cookie"] as string[] | undefined
    )?.find((header) => header.startsWith("cqut_manage_csrf="));
    assert.ok(clearHeader);
    assert.match(clearHeader, /HttpOnly/i);
    assert.match(clearHeader, /Expires=/i);
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management login rotates pre-login csrf nonce cookie", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const agent = request.agent(app);
    const context = await agent.get("/api/management/auth/context");
    const preLoginCsrf = context.body.csrfToken;
    const preLoginNonce = getSetCookieValue(context, "cqut_manage_csrf");
    assert.ok(preLoginNonce);

    const signedIn = await login(agent, "admin-account");
    assert.equal(signedIn.status, 200);
    const postLoginNonce = getSetCookieValue(signedIn, "cqut_manage_csrf");
    assert.ok(postLoginNonce);
    assert.notEqual(postLoginNonce, preLoginNonce);

    const replay = await agent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", preLoginCsrf)
      .send({ account: "admin-account", password: "valid-password" });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error_description, "CSRF validation failed");
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management login rejects oversized credentials", async () => {
  const { app, state } = await createApp();
  try {
    const agent = request.agent(app);
    const context = await agent.get("/api/management/auth/context");
    const response = await agent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", context.body.csrfToken)
      .send({ account: "a".repeat(129), password: "p".repeat(257) });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "invalid_request");
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management login upstream outage rolls back consumed attempt rate-limit budget", async () => {
  const { app, state } = await createApp({ OIDC_LOGIN_RATE_LIMIT_MAX: "1" });
  try {
    const agent = request.agent(app);
    for (let index = 0; index < 2; index += 1) {
      const context = await agent.get("/api/management/auth/context");
      const response = await agent
        .post("/api/management/auth/login")
        .set("X-CSRF-Token", context.body.csrfToken)
        .send({
          account: "outage-account",
          password: MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD,
        });
      assert.equal(response.status, 503);
      assert.equal(response.headers["retry-after"], "60");
    }
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management login rolls back attempt budget when failure rate limiter is unavailable", async () => {
  const { app, state } = await createApp({ OIDC_LOGIN_RATE_LIMIT_MAX: "2" });
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
  try {
    const agent = request.agent(app);
    const firstContext = await agent.get("/api/management/auth/context");
    const first = await agent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", firstContext.body.csrfToken)
      .send({ account: "failure-limit-outage", password: "" });
    assert.equal(first.status, 401);

    failFailureConsume = true;
    const secondContext = await agent.get("/api/management/auth/context");
    const second = await agent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", secondContext.body.csrfToken)
      .send({ account: "failure-limit-outage", password: "" });
    assert.equal(second.status, 503);
    assert.equal(second.headers["retry-after"], "60");

    failFailureConsume = false;
    const thirdContext = await agent.get("/api/management/auth/context");
    const third = await agent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", thirdContext.body.csrfToken)
      .send({ account: "failure-limit-outage", password: "" });
    assert.equal(third.status, 401);
  } finally {
    state.rateLimitService.consume = originalConsume;
    await state.persistence.runtime.close();
  }
});

test("management login attempt rate limit outage rolls back partial consume", async () => {
  const { app, state } = await createApp({ OIDC_LOGIN_RATE_LIMIT_MAX: "1" });
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
  try {
    const agent = request.agent(app);
    failAttemptIp = true;
    const context = await agent.get("/api/management/auth/context");
    const outage = await agent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", context.body.csrfToken)
      .send({ account: "partial-outage-account", password: "" });
    assert.equal(outage.status, 503);
    assert.equal(outage.headers["retry-after"], "60");

    failAttemptIp = false;
    const retryContext = await agent.get("/api/management/auth/context");
    const retry = await agent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", retryContext.body.csrfToken)
      .send({ account: "partial-outage-account", password: "" });
    assert.equal(retry.status, 401);
  } finally {
    state.rateLimitService.consume = originalConsume;
    await state.persistence.runtime.close();
  }
});

test("management re-login invalidates prior session tokens", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const firstAgent = request.agent(app);
    const secondAgent = request.agent(app);
    const firstLogin = await login(firstAgent, "admin-account");
    await login(secondAgent, "admin-account");

    const stale = await firstAgent
      .get("/api/management/projects")
      .set("X-CSRF-Token", firstLogin.body.csrfToken);
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error, "login_required");
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management project quota rejection does not consume creation rate limit", async () => {
  const { app, state } = await createApp({
    OIDC_MANAGEMENT_PROJECT_QUOTA_ADMIN_EXEMPT: "false",
    OIDC_MANAGEMENT_PROJECT_MAX_ACTIVE_PER_SUBJECT: "1",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_SUBJECT_MAX: "5",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_IP_MAX: "5",
  });
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    assert.equal(
      (
        await admin
          .post("/api/management/projects")
          .set("X-CSRF-Token", signedIn.body.csrfToken)
          .send({ name: "Only project", description: "" })
      ).status,
      201,
    );
    for (let index = 0; index < 5; index += 1) {
      const rejected = await admin
        .post("/api/management/projects")
        .set("X-CSRF-Token", signedIn.body.csrfToken)
        .send({ name: `Too many ${index}`, description: "" });
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.error, "project_quota_exceeded");
    }
    const stillQuota = await admin
      .post("/api/management/projects")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ name: "Still too many", description: "" });
    assert.equal(stillQuota.status, 409);
    assert.equal(stillQuota.body.error, "project_quota_exceeded");
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management login normalizes account rate-limit keys", async () => {
  const { app, state } = await createApp({ OIDC_LOGIN_RATE_LIMIT_MAX: "1" });
  try {
    const firstAgent = request.agent(app);
    const firstContext = await firstAgent.get("/api/management/auth/context");
    const first = await firstAgent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", firstContext.body.csrfToken)
      .send({ account: "Student001", password: "valid-password" });
    const secondAgent = request.agent(app);
    const secondContext = await secondAgent.get("/api/management/auth/context");
    const second = await secondAgent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", secondContext.body.csrfToken)
      .send({ account: "STUDENT001", password: "valid-password" });

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management login blocks account spraying from one ip", async () => {
  const { app, state } = await createApp({ OIDC_LOGIN_RATE_LIMIT_MAX: "2" });
  try {
    const statuses: number[] = [];
    for (const account of ["spray-a", "spray-b", "spray-c"]) {
      const agent = request.agent(app);
      const context = await agent.get("/api/management/auth/context");
      const response = await agent
        .post("/api/management/auth/login")
        .set("X-CSRF-Token", context.body.csrfToken)
        .send({ account, password: "valid-password" });
      statuses.push(response.status);
    }

    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await state.persistence.runtime.close();
  }
});
