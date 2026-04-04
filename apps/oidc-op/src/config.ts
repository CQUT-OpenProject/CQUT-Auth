export type OidcOpConfig = {
  port: number;
  appEnv: string;
  isProduction: boolean;
  trustProxyHops: number;
  issuer: string;
  schoolCode: string;
  authProvider: string;
  providerTimeoutMs: number;
  providerTotalTimeoutMs: number;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  allowInMemoryStore: boolean;
  cookieKeys: string[];
  keyEncryptionSecret: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  interactionTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  accessTokenTtlSeconds: number;
  idTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  artifactCleanupEnabled: boolean;
  artifactCleanupCron: string;
  loginRateLimitMax: number;
  loginRateLimitWindowSeconds: number;
  loginFailureLimit: number;
  loginFailureWindowSeconds: number;
  tokenRateLimitMax: number;
  tokenRateLimitWindowSeconds: number;
  rateLimitFailClosed: boolean;
  rateLimitMemoryMaxKeys: number;
  rateLimitMemoryCleanupIntervalSeconds: number;
  artifactOpportunisticCleanupEnabled: boolean;
  artifactOpportunisticCleanupSampleRate: number;
  artifactOpportunisticCleanupBatchSize: number;
  artifactOpportunisticCleanupIntervalSeconds: number;
  demoClientEnabled: boolean;
  demoClientId: string;
  demoClientSecret: string;
  demoRedirectUri: string;
  demoPostLogoutRedirectUri: string;
  autoSeedSigningKey: boolean;
};

function requireSecret(env: NodeJS.ProcessEnv, key: string, allowDefaultForTest = false): string {
  const value = env[key];
  if (value) {
    return value;
  }
  if (allowDefaultForTest) {
    return `test-${key.toLowerCase()}`;
  }
  throw new Error(`${key} is required`);
}

export function readOidcOpConfig(env: NodeJS.ProcessEnv = process.env): OidcOpConfig {
  const appEnv = env["APP_ENV"] ?? env["NODE_ENV"] ?? "development";
  const isProduction = appEnv === "production";
  const port = Number(env["PORT"] ?? 3003);
  const allowInMemoryStore = env["OIDC_ALLOW_IN_MEMORY_STORE"] === "true" || appEnv === "test";
  const issuer = env["OIDC_ISSUER"] ?? (appEnv === "test" ? `http://127.0.0.1:${port}` : `http://localhost:${port}`);
  const cookieKeysRaw = env["OIDC_COOKIE_KEYS"];
  const cookieKeys = cookieKeysRaw
    ? cookieKeysRaw.split(",").map((value) => value.trim()).filter(Boolean)
    : [requireSecret(env, "OIDC_KEY_ENCRYPTION_SECRET", appEnv === "test")];
  const demoClientEnabled =
    env["OIDC_DEMO_CLIENT_ENABLED"] !== undefined
      ? env["OIDC_DEMO_CLIENT_ENABLED"] === "true"
      : !isProduction;
  const artifactCleanupEnabledRaw = env["OIDC_ARTIFACT_CLEANUP_ENABLED"];
  const artifactCleanupEnabled =
    artifactCleanupEnabledRaw !== undefined ? artifactCleanupEnabledRaw === "true" : true;
  if (!artifactCleanupEnabled) {
    throw new Error("OIDC_ARTIFACT_CLEANUP_ENABLED must be true");
  }
  const sessionTtlSeconds = Number(env["OIDC_SESSION_TTL_SECONDS"] ?? 60 * 60 * 8);
  const sessionIdleTtlSeconds = Number(env["OIDC_SESSION_IDLE_TTL_SECONDS"] ?? 60 * 60 * 2);
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error("OIDC_SESSION_TTL_SECONDS must be a positive number");
  }
  if (!Number.isFinite(sessionIdleTtlSeconds) || sessionIdleTtlSeconds <= 0) {
    throw new Error("OIDC_SESSION_IDLE_TTL_SECONDS must be a positive number");
  }
  if (sessionIdleTtlSeconds > sessionTtlSeconds) {
    throw new Error("OIDC_SESSION_IDLE_TTL_SECONDS must be less than or equal to OIDC_SESSION_TTL_SECONDS");
  }

  const rateLimitFailClosed =
    env["OIDC_RATE_LIMIT_FAIL_CLOSED"] !== undefined
      ? env["OIDC_RATE_LIMIT_FAIL_CLOSED"] === "true"
      : Boolean(env["REDIS_URL"]) && appEnv !== "test";
  const rateLimitMemoryMaxKeys = Number(env["OIDC_RATE_LIMIT_MEMORY_MAX_KEYS"] ?? 10000);
  const rateLimitMemoryCleanupIntervalSeconds = Number(
    env["OIDC_RATE_LIMIT_MEMORY_CLEANUP_INTERVAL_SECONDS"] ?? 60
  );
  if (!Number.isInteger(rateLimitMemoryMaxKeys) || rateLimitMemoryMaxKeys <= 0) {
    throw new Error("OIDC_RATE_LIMIT_MEMORY_MAX_KEYS must be a positive integer");
  }
  if (!Number.isInteger(rateLimitMemoryCleanupIntervalSeconds) || rateLimitMemoryCleanupIntervalSeconds <= 0) {
    throw new Error("OIDC_RATE_LIMIT_MEMORY_CLEANUP_INTERVAL_SECONDS must be a positive integer");
  }

  const artifactOpportunisticCleanupEnabled =
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_ENABLED"] !== undefined
      ? env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_ENABLED"] === "true"
      : true;
  const artifactOpportunisticCleanupSampleRate = Number(
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_SAMPLE_RATE"] ?? 0.01
  );
  const artifactOpportunisticCleanupBatchSize = Number(
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_BATCH_SIZE"] ?? 200
  );
  const artifactOpportunisticCleanupIntervalSeconds = Number(
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_INTERVAL_SECONDS"] ?? 30
  );
  if (
    !Number.isFinite(artifactOpportunisticCleanupSampleRate) ||
    artifactOpportunisticCleanupSampleRate < 0 ||
    artifactOpportunisticCleanupSampleRate > 1
  ) {
    throw new Error("OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_SAMPLE_RATE must be between 0 and 1");
  }
  if (!Number.isInteger(artifactOpportunisticCleanupBatchSize) || artifactOpportunisticCleanupBatchSize <= 0) {
    throw new Error("OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_BATCH_SIZE must be a positive integer");
  }
  if (
    !Number.isInteger(artifactOpportunisticCleanupIntervalSeconds) ||
    artifactOpportunisticCleanupIntervalSeconds <= 0
  ) {
    throw new Error("OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_INTERVAL_SECONDS must be a positive integer");
  }

  const artifactCleanupCron = env["OIDC_ARTIFACT_CLEANUP_CRON"] ?? "*/5 * * * *";
  return {
    port,
    appEnv,
    isProduction,
    trustProxyHops: Number(env["TRUST_PROXY_HOPS"] ?? (isProduction ? 1 : 0)),
    issuer,
    schoolCode: env["SCHOOL_CODE"] ?? "cqut",
    authProvider: env["AUTH_PROVIDER"] ?? "mock",
    providerTimeoutMs: Number(env["PROVIDER_TIMEOUT_MS"] ?? 10000),
    providerTotalTimeoutMs: Number(env["PROVIDER_TOTAL_TIMEOUT_MS"] ?? 20000),
    databaseUrl: env["DATABASE_URL"],
    redisUrl: env["REDIS_URL"],
    allowInMemoryStore,
    cookieKeys,
    keyEncryptionSecret: requireSecret(env, "OIDC_KEY_ENCRYPTION_SECRET", appEnv === "test"),
    cookieSecure: env["OIDC_COOKIE_SECURE"] !== undefined ? env["OIDC_COOKIE_SECURE"] !== "false" : appEnv !== "test",
    sessionTtlSeconds,
    sessionIdleTtlSeconds,
    interactionTtlSeconds: Number(env["OIDC_INTERACTION_TTL_SECONDS"] ?? 60 * 15),
    authorizationCodeTtlSeconds: Number(env["OIDC_AUTHORIZATION_CODE_TTL_SECONDS"] ?? 60),
    accessTokenTtlSeconds: Number(env["OIDC_ACCESS_TOKEN_TTL_SECONDS"] ?? 60 * 5),
    idTokenTtlSeconds: Number(env["OIDC_ID_TOKEN_TTL_SECONDS"] ?? 60 * 5),
    refreshTokenTtlSeconds: Number(env["OIDC_REFRESH_TTL_SECONDS"] ?? 60 * 60 * 24 * 30),
    artifactCleanupEnabled,
    artifactCleanupCron,
    loginRateLimitMax: Number(env["OIDC_LOGIN_RATE_LIMIT_MAX"] ?? 10),
    loginRateLimitWindowSeconds: Number(env["OIDC_LOGIN_RATE_LIMIT_WINDOW_SECONDS"] ?? 60),
    loginFailureLimit: Number(env["OIDC_LOGIN_FAILURE_LIMIT"] ?? 5),
    loginFailureWindowSeconds: Number(env["OIDC_LOGIN_FAILURE_WINDOW_SECONDS"] ?? 60 * 5),
    tokenRateLimitMax: Number(env["OIDC_TOKEN_RATE_LIMIT_MAX"] ?? 20),
    tokenRateLimitWindowSeconds: Number(env["OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS"] ?? 60),
    rateLimitFailClosed,
    rateLimitMemoryMaxKeys,
    rateLimitMemoryCleanupIntervalSeconds,
    artifactOpportunisticCleanupEnabled,
    artifactOpportunisticCleanupSampleRate,
    artifactOpportunisticCleanupBatchSize,
    artifactOpportunisticCleanupIntervalSeconds,
    demoClientEnabled,
    demoClientId: env["OIDC_DEMO_CLIENT_ID"] ?? "demo-site",
    demoClientSecret: env["OIDC_DEMO_CLIENT_SECRET"] ?? "demo-site-secret",
    demoRedirectUri: env["OIDC_DEMO_REDIRECT_URI"] ?? "http://localhost:3002/demo/callback",
    demoPostLogoutRedirectUri: env["OIDC_DEMO_POST_LOGOUT_REDIRECT_URI"] ?? "http://localhost:3002/demo",
    autoSeedSigningKey:
      env["OIDC_AUTO_SEED_SIGNING_KEY"] !== undefined
        ? env["OIDC_AUTO_SEED_SIGNING_KEY"] === "true"
        : appEnv === "test"
  };
}
