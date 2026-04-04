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
    sessionTtlSeconds: Number(env["OIDC_SESSION_TTL_SECONDS"] ?? 60 * 60 * 8),
    sessionIdleTtlSeconds: Number(env["OIDC_SESSION_IDLE_TTL_SECONDS"] ?? 60 * 60 * 2),
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
