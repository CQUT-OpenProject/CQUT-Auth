import { test } from "vite-plus/test";
import {
  PROD_ARTIFACT_SECRET,
  PROD_CSRF_SECRET,
  PROD_KEY_SECRET,
  RateLimitUnavailableError,
  TEST_DEMO_CLIENT_SECRET,
  TEST_REDIRECT_URI,
  assert,
  computeSessionTtlSeconds,
  createProductionConfigEnv,
  createTestApp,
  readConfig,
  request,
  upsertPublicNoneClient,
} from "./oidc-op.helpers.js";

test("OIDC error page returns generic message only", async () => {
  const { app, state } = await createTestApp();
  const response = await request(app).get("/auth");
  assert.ok(response.status >= 400);
  assert.match(response.text, /认证请求未能完成，请刷新后重试。/);
  assert.doesNotMatch(response.text, /client_id|required|invalid_request/i);
  await state.persistence.runtime.close();
});

test("token endpoint returns 503 when rate limiter is fail-closed and redis is unavailable", async () => {
  const { app, state } = await createTestApp({
    REDIS_URL: "redis://127.0.0.1:1",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "true",
  });
  const response = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token" });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "service_unavailable");
  await state.persistence.runtime.close();
});

test("token endpoint returns 503 when fail-closed mode is enabled and REDIS_URL is missing", async () => {
  const { app, state } = await createTestApp({
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "true",
  });
  const response = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({ grant_type: "refresh_token", refresh_token: "missing-token" });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "service_unavailable");
  await state.persistence.runtime.close();
});

test("token endpoint rate limit outage rolls back partial consume", async () => {
  const { app, state } = await createTestApp({
    OIDC_TOKEN_RATE_LIMIT_MAX: "1",
  });
  const originalConsume = state.rateLimitService.consume.bind(
    state.rateLimitService,
  );
  let failClientIp = false;
  state.rateLimitService.consume = async (key, max, windowSeconds) => {
    if (failClientIp && key.includes(":client-ip:")) {
      throw new RateLimitUnavailableError();
    }
    return originalConsume(key, max, windowSeconds);
  };
  try {
    failClientIp = true;
    const outage = await request(app)
      .post("/token")
      .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: "missing-token" });
    assert.equal(outage.status, 503);
    assert.equal(outage.body.error, "service_unavailable");

    failClientIp = false;
    const retry = await request(app)
      .post("/token")
      .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: "missing-token" });
    assert.notEqual(retry.status, 429);
  } finally {
    state.rateLimitService.consume = originalConsume;
    await state.persistence.runtime.close();
  }
});

test("token endpoint rate limit blocks the same none-auth client_id across trusted proxy ips", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "2",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60",
  });
  await upsertPublicNoneClient(state, "public-a");

  const first = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.61")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code: "missing-code-a-1",
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: "missing-verifier",
      client_id: "public-a",
    });
  const second = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.62")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code: "missing-code-a-2",
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: "missing-verifier",
      client_id: "public-a",
    });
  const third = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.63")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code: "missing-code-a-3",
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: "missing-verifier",
      client_id: "public-a",
    });

  assert.notEqual(first.status, 429);
  assert.notEqual(second.status, 429);
  assert.equal(third.status, 429);
  await state.persistence.runtime.close();
});

test("token endpoint rate limit blocks multiple none-auth client_ids from the same trusted proxy ip", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "2",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60",
  });
  await upsertPublicNoneClient(state, "public-a");
  await upsertPublicNoneClient(state, "public-b");
  await upsertPublicNoneClient(state, "public-c");

  const first = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.70")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code: "missing-code-a-1",
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: "missing-verifier",
      client_id: "public-a",
    });
  const second = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.70")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code: "missing-code-b-1",
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: "missing-verifier",
      client_id: "public-b",
    });
  const third = await request(app)
    .post("/token")
    .set("X-Forwarded-For", "198.51.100.70")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code: "missing-code-c-1",
      redirect_uri: TEST_REDIRECT_URI,
      code_verifier: "missing-verifier",
      client_id: "public-c",
    });

  assert.notEqual(first.status, 429);
  assert.notEqual(second.status, 429);
  assert.equal(third.status, 429);
  await state.persistence.runtime.close();
});

test("token endpoint rate limit isolates Basic client bucket from none client bucket", async () => {
  const { app, state } = await createTestApp({
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "1",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60",
  });
  await upsertPublicNoneClient(state, "public-b");

  const first = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: "missing-token-basic-1",
    });
  const second = await request(app)
    .post("/token")
    .auth("demo-site", TEST_DEMO_CLIENT_SECRET, { type: "basic" })
    .type("form")
    .send({
      grant_type: "refresh_token",
      refresh_token: "missing-token-basic-2",
    });
  const noneClient = await request(app).post("/token").type("form").send({
    grant_type: "refresh_token",
    refresh_token: "missing-token-none-1",
    client_id: "public-b",
  });

  assert.notEqual(first.status, 429);
  assert.equal(second.status, 429);
  assert.notEqual(noneClient.status, 429);
  await state.persistence.runtime.close();
});

test("token endpoint rate limit uses anonymous fallback bucket when client identity is missing", async () => {
  const { app, state } = await createTestApp({
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "1",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60",
  });

  const first = await request(app)
    .post("/token")
    .type("form")
    .send({ grant_type: "refresh_token" });
  const second = await request(app)
    .post("/token")
    .type("form")
    .send({ grant_type: "refresh_token" });

  assert.equal(first.status, 400);
  assert.equal(first.body.error, "invalid_request");
  assert.equal(second.status, 429);
  assert.equal(second.body.error, "rate_limited");
  await state.persistence.runtime.close();
});

test("token endpoint trusted proxy resolution ignores spoofed leading forwarded ips", async () => {
  const { app, state } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    REDIS_URL: "",
    OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    OIDC_TOKEN_RATE_LIMIT_MAX: "1",
    OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS: "60",
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
  await state.persistence.runtime.close();
});

test("session ttl uses idle ttl when absolute ttl has more remaining time", () => {
  const ttl = computeSessionTtlSeconds(
    { loginTs: 1000, iat: 900 },
    { sessionIdleTtlSeconds: 120, sessionTtlSeconds: 600 },
    1050,
  );
  assert.equal(ttl, 120);
});

test("session ttl is capped by absolute ttl remaining from login time", () => {
  const ttl = computeSessionTtlSeconds(
    { loginTs: 1000, iat: 900 },
    { sessionIdleTtlSeconds: 600, sessionTtlSeconds: 600 },
    1400,
  );
  assert.equal(ttl, 200);
});

test("session ttl falls back to iat when loginTs is missing", () => {
  const ttl = computeSessionTtlSeconds(
    { iat: 1000 },
    { sessionIdleTtlSeconds: 300, sessionTtlSeconds: 300 },
    1301,
  );
  assert.equal(ttl, 0);
});

test("session ttl absolute window resets after re-login", () => {
  const oldSessionTtl = computeSessionTtlSeconds(
    { loginTs: 1000, iat: 900 },
    { sessionIdleTtlSeconds: 300, sessionTtlSeconds: 300 },
    1300,
  );
  const refreshedSessionTtl = computeSessionTtlSeconds(
    { loginTs: 1280, iat: 900 },
    { sessionIdleTtlSeconds: 300, sessionTtlSeconds: 300 },
    1300,
  );
  assert.equal(oldSessionTtl, 0);
  assert.equal(refreshedSessionTtl, 280);
});

test("config ignores migrated runtime-policy env variables", () => {
  const config = readConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
    OIDC_SESSION_TTL_SECONDS: "60",
    OIDC_SESSION_IDLE_TTL_SECONDS: "120",
    OIDC_REFRESH_TTL_SECONDS: "1000",
    OIDC_GRANT_TTL_SECONDS: "500",
    OIDC_CSRF_TOKEN_TTL_SECONDS: "900",
  });
  assert.equal(config.sessionTtlSeconds, 60 * 60 * 8);
  assert.equal(config.sessionIdleTtlSeconds, 60 * 60 * 2);
  assert.equal(config.refreshTokenTtlSeconds, 60 * 60 * 24 * 30);
  assert.equal(config.grantTtlSeconds, 60 * 60 * 24 * 90);
  assert.equal(config.csrfTokenTtlSeconds, 600);
});

test("config ignores deprecated OIDC_DEMO_* variables", () => {
  const config = readConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_DEMO_CLIENT_SECRET: TEST_DEMO_CLIENT_SECRET,
    OIDC_DEMO_REDIRECT_URI: "https://deprecated.example.com/callback",
    OIDC_DEMO_POST_LOGOUT_REDIRECT_URI: "https://deprecated.example.com/logout",
    OIDC_DEMO_CLIENT_ENABLED: "true",
    OIDC_DEMO_CLIENT_ID: "deprecated-client-id",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
  });
  assert.equal(config.oidcClientsConfigPath, "/app/config/oidc-clients.json");
});

test("config rejects missing OIDC_ARTIFACT_ENCRYPTION_SECRET outside test", () => {
  assert.throws(
    () =>
      readConfig({
        APP_ENV: "development",
        OIDC_ISSUER: "https://localhost:3003",
        OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
      }),
    /OIDC_ARTIFACT_ENCRYPTION_SECRET is required/,
  );
});

test("config rejects short encryption secret outside test", () => {
  assert.throws(
    () =>
      readConfig({
        APP_ENV: "development",
        OIDC_ISSUER: "https://localhost:3003",
        OIDC_KEY_ENCRYPTION_SECRET: "short-secret",
        OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
      }),
    /OIDC_KEY_ENCRYPTION_SECRET must be at least 32 characters/,
  );
});

test("config rejects identical artifact and key encryption secrets", () => {
  assert.throws(
    () =>
      readConfig({
        APP_ENV: "test",
        OIDC_KEY_ENCRYPTION_SECRET: "same-secret",
        OIDC_ARTIFACT_ENCRYPTION_SECRET: "same-secret",
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
      }),
    /OIDC_ARTIFACT_ENCRYPTION_SECRET must be different from OIDC_KEY_ENCRYPTION_SECRET/,
  );
});

test("config accepts explicit OIDC_CLIENTS_CONFIG_PATH", () => {
  const config = readConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_CLIENTS_CONFIG_PATH: "/tmp/custom-oidc-clients.json",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
  });
  assert.equal(config.oidcClientsConfigPath, "/tmp/custom-oidc-clients.json");
});

test("config defaults AUTH_PROVIDER to cqut", () => {
  const config = readConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
  });
  assert.equal(config.authProvider, "cqut");
  assert.equal(config.oidcClientsConfigPath, "/app/config/oidc-clients.json");
  assert.deepEqual(config.cookieKeys, ["test-oidc-key-secret"]);
  assert.equal(config.csrfSigningSecret, "test-oidc-key-secret");
  assert.equal(config.signingKeyRefreshIntervalSeconds, 30);
  assert.equal(config.artifactOpportunisticCleanupEnabled, false);
});

test("config allows AUTH_PROVIDER=mock in test", () => {
  const config = readConfig({
    APP_ENV: "test",
    AUTH_PROVIDER: "mock",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
  });
  assert.equal(config.authProvider, "mock");
});

test("config defaults email verification global rate limits to strict profile", () => {
  const config = readConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
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

test("config defaults client creation quotas and rate limits", () => {
  const config = readConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
  });
  assert.equal(config.managementClientMaxPerProject, 10);
  assert.equal(config.managementClientMaxPerSubject, 30);
  assert.equal(config.managementProjectMaxActivePerSubject, 5);
  assert.equal(config.managementProjectCreateRateLimitSubjectMax, 3);
  assert.equal(config.managementProjectCreateRateLimitIpMax, 10);
  assert.equal(config.managementProjectCreateRateLimitWindowSeconds, 3600);
  assert.equal(config.managementProjectQuotaAdminExempt, true);
  assert.equal(config.managementClientCreateRateLimitSubjectMax, 5);
  assert.equal(config.managementClientCreateRateLimitIpMax, 20);
  assert.equal(config.managementClientCreateRateLimitWindowSeconds, 3600);
  assert.equal(config.managementClientQuotaAdminExempt, true);
  assert.equal(config.clientSecretDefaultGraceSeconds, 86_400);
  assert.equal(config.clientSecretMaxGraceSeconds, 604_800);
  assert.equal(config.clientSecretRotateRateLimitSubjectMax, 10);
  assert.equal(config.clientSecretRotateRateLimitClientMax, 5);
  assert.equal(config.clientSecretRotateRateLimitIpMax, 20);
  assert.equal(config.clientSecretRotateRateLimitWindowSeconds, 3_600);
  assert.equal(config.clientSecretRotateMinimumIntervalSeconds, 60);
});

test("config allows explicitly enabling opportunistic cleanup", () => {
  const config = readConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
    OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_ENABLED: "true",
  });
  assert.equal(config.artifactOpportunisticCleanupEnabled, true);
});

test("config rejects non-positive signing key refresh interval", () => {
  assert.throws(
    () =>
      readConfig({
        APP_ENV: "test",
        OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
        OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
        OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS: "0",
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
      }),
    /OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS must be a positive integer/,
  );
});

test("config rejects missing OIDC_COOKIE_KEYS in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_COOKIE_KEYS: undefined,
        }),
      ),
    /OIDC_COOKIE_KEYS is required when APP_ENV=production/,
  );
});

test("config rejects missing OIDC_CSRF_SIGNING_SECRET in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_CSRF_SIGNING_SECRET: undefined,
        }),
      ),
    /OIDC_CSRF_SIGNING_SECRET is required when APP_ENV=production/,
  );
});

test("config rejects csrf signing secret reused as key encryption secret in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_CSRF_SIGNING_SECRET: PROD_KEY_SECRET,
        }),
      ),
    /OIDC_CSRF_SIGNING_SECRET must be different from OIDC_KEY_ENCRYPTION_SECRET/,
  );
});

test("config rejects cookie key reused as key encryption secret in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_COOKIE_KEYS: `${PROD_KEY_SECRET},prod-cookie-b-0123456789`,
        }),
      ),
    /OIDC_COOKIE_KEYS entries must be different from OIDC_KEY_ENCRYPTION_SECRET/,
  );
});

test("config rejects cookie key reused as csrf signing secret in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_COOKIE_KEYS: `${PROD_CSRF_SECRET},prod-cookie-b-0123456789`,
        }),
      ),
    /OIDC_COOKIE_KEYS entries must be different from OIDC_CSRF_SIGNING_SECRET/,
  );
});

test("config rejects non-https issuer outside test", () => {
  assert.throws(
    () =>
      readConfig({
        APP_ENV: "development",
        OIDC_ISSUER: "http://localhost:3003",
        OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
        OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
      }),
    /OIDC_ISSUER must use https:\/\//,
  );
});

test("config allows loopback http issuer in test", () => {
  const config = readConfig({
    APP_ENV: "test",
    OIDC_ISSUER: "http://127.0.0.1:3003",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
  });
  assert.equal(config.issuer, "http://127.0.0.1:3003");
});

test("config accepts exact Agent API CORS origins and requires HTTPS in production", () => {
  const config = readConfig({
    APP_ENV: "development",
    OIDC_ISSUER: "https://verify.local",
    OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
    OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
    OIDC_AGENT_API_CORS_ORIGINS:
      "http://localhost:5173,https://docs.example.com",
  });
  assert.deepEqual(config.agentApiCorsOrigins, [
    "http://localhost:5173",
    "https://docs.example.com",
  ]);

  assert.throws(
    () =>
      readConfig({
        APP_ENV: "development",
        OIDC_ISSUER: "https://verify.local",
        OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
        OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
        OIDC_AGENT_API_CORS_ORIGINS: "https://docs.example.com/path",
      }),
    /OIDC_AGENT_API_CORS_ORIGINS must contain valid HTTP origins/,
  );
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_AGENT_API_CORS_ORIGINS: "http://docs.example.com",
        }),
      ),
    /OIDC_AGENT_API_CORS_ORIGINS must contain valid HTTP origins/,
  );
});

test("config rejects AUTH_PROVIDER=mock outside test", () => {
  assert.throws(
    () =>
      readConfig({
        APP_ENV: "development",
        OIDC_ISSUER: "https://localhost:3003",
        AUTH_PROVIDER: "mock",
        OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
        OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
      }),
    /AUTH_PROVIDER=mock is only allowed when APP_ENV=test/,
  );
  assert.throws(
    () =>
      readConfig({
        APP_ENV: "production",
        OIDC_ISSUER: "https://localhost:3003",
        AUTH_PROVIDER: "mock",
        OIDC_KEY_ENCRYPTION_SECRET: PROD_KEY_SECRET,
        OIDC_ARTIFACT_ENCRYPTION_SECRET: PROD_ARTIFACT_SECRET,
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
      }),
    /AUTH_PROVIDER=mock is only allowed when APP_ENV=test/,
  );
});

test("config rejects OIDC_ALLOW_IN_MEMORY_STORE=true in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_ALLOW_IN_MEMORY_STORE: "true",
        }),
      ),
    /OIDC_ALLOW_IN_MEMORY_STORE=true is not allowed when APP_ENV=production/,
  );
});

test("config rejects missing DATABASE_URL in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          DATABASE_URL: undefined,
        }),
      ),
    /DATABASE_URL is required when APP_ENV=production/,
  );
});

test("config rejects missing REDIS_URL in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          REDIS_URL: undefined,
        }),
      ),
    /REDIS_URL is required when APP_ENV=production/,
  );
});

test("config allows small production deployment without redis", () => {
  const config = readConfig(
    createProductionConfigEnv({
      OIDC_SMALL_DEPLOYMENT: "true",
      REDIS_URL: undefined,
      OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
    }),
  );
  assert.equal(config.smallDeployment, true);
  assert.equal(config.redisUrl, undefined);
  assert.equal(config.rateLimitFailClosed, false);
});

test("config rejects small production deployment with fail-closed and no redis", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_SMALL_DEPLOYMENT: "true",
          REDIS_URL: undefined,
          OIDC_RATE_LIMIT_FAIL_CLOSED: "true",
        }),
      ),
    /OIDC_RATE_LIMIT_FAIL_CLOSED cannot be true without REDIS_URL when OIDC_SMALL_DEPLOYMENT=true/,
  );
});

test("config rejects small deployment flag outside production", () => {
  assert.throws(
    () =>
      readConfig({
        APP_ENV: "test",
        OIDC_SMALL_DEPLOYMENT: "true",
        OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
        OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
        OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
      }),
    /OIDC_SMALL_DEPLOYMENT is only allowed when APP_ENV=production/,
  );
});

test("config rejects OIDC_RATE_LIMIT_FAIL_CLOSED=false in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_RATE_LIMIT_FAIL_CLOSED: "false",
        }),
      ),
    /OIDC_RATE_LIMIT_FAIL_CLOSED must be true when APP_ENV=production/,
  );
});

test("config rejects TRUST_PROXY_HOPS=0 in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          TRUST_PROXY_HOPS: "0",
        }),
      ),
    /TRUST_PROXY_HOPS must be 1 when APP_ENV=production/,
  );
});

test("config rejects TRUST_PROXY_HOPS=2 in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          TRUST_PROXY_HOPS: "2",
        }),
      ),
    /TRUST_PROXY_HOPS must be 1 when APP_ENV=production/,
  );
});

test("config rejects empty TRUSTED_PROXY_CIDRS when proxy trust is enabled", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          TRUSTED_PROXY_CIDRS: "",
        }),
      ),
    /TRUSTED_PROXY_CIDRS must contain at least one CIDR/,
  );
});

test("config allows TRUST_PROXY_HOPS=0 in test", () => {
  const config = readConfig({
    APP_ENV: "test",
    TRUST_PROXY_HOPS: "0",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
  });
  assert.equal(config.trustProxyHops, 0);
});

test("config rejects disabling email verification in production", () => {
  assert.throws(
    () =>
      readConfig(
        createProductionConfigEnv({
          OIDC_EMAIL_VERIFICATION_ENABLED: "false",
        }),
      ),
    /OIDC_EMAIL_VERIFICATION_ENABLED must remain enabled when APP_ENV=production/,
  );
});
