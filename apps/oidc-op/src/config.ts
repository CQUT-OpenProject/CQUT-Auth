export type OidcOpConfig = {
  port: number;
  appEnv: string;
  isProduction: boolean;
  trustProxyHops: number;
  issuer: string;
  schoolCode: string;
  authProvider: string;
  emailVerificationEnabled: boolean;
  resendApiKey: string | undefined;
  emailFrom: string | undefined;
  emailVerifyCodeTtlSeconds: number;
  emailVerifyResendCooldownSeconds: number;
  emailVerifyMaxAttempts: number;
  emailVerifyRateLimitSubjectMax: number;
  emailVerifyRateLimitSubjectWindowSeconds: number;
  emailVerifyRateLimitEmailMax: number;
  emailVerifyRateLimitEmailWindowSeconds: number;
  emailVerifyRateLimitDomainMax: number;
  emailVerifyRateLimitDomainWindowSeconds: number;
  emailVerifyRateLimitIpMax: number;
  emailVerifyRateLimitIpWindowSeconds: number;
  providerTimeoutMs: number;
  providerTotalTimeoutMs: number;
  cqutUisBaseUrl: string;
  cqutCasApplicationCode: string;
  cqutCasServiceUrl: string;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  allowInMemoryStore: boolean;
  cookieKeys: string[];
  keyEncryptionSecret: string;
  artifactEncryptionSecret: string;
  cookieSecure: boolean;
  csrfSigningSecret: string;
  csrfTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  interactionTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  accessTokenTtlSeconds: number;
  idTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  artifactCleanupEnabled: boolean;
  artifactCleanupCron: string;
  artifactCleanupBatchSize: number;
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
  signingKeyRefreshIntervalSeconds: number;
  oidcClientsConfigPath: string;
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

function assertStrongEncryptionSecret(secret: string, key: string, appEnv: string) {
  if (appEnv === "test") {
    return;
  }
  if (secret.length < 32) {
    throw new Error(`${key} must be at least 32 characters and generated from high-entropy randomness`);
  }
}

function parseAbsoluteUrl(value: string, key: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function assertHttpsOrTestLoopbackHttp(value: string, key: string, appEnv: string) {
  const parsed = parseAbsoluteUrl(value, key);
  if (parsed.protocol === "https:") {
    return;
  }
  if (appEnv === "test" && parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return;
  }
  if (appEnv === "test") {
    throw new Error(`${key} must use https:// or loopback http://localhost|127.0.0.1 in test`);
  }
  throw new Error(`${key} must use https:// when APP_ENV is not test`);
}

export function readOidcOpConfig(env: NodeJS.ProcessEnv = process.env): OidcOpConfig {
  const appEnv = env["APP_ENV"] ?? env["NODE_ENV"] ?? "development";
  const isProduction = appEnv === "production";
  const trustProxyHops = Number(env["TRUST_PROXY_HOPS"] ?? (isProduction ? 1 : 0));
  const emailVerificationEnabled = env["OIDC_EMAIL_VERIFICATION_ENABLED"] !== "false";
  const resendApiKey = env["RESEND_API_KEY"]?.trim() || undefined;
  const emailFrom = env["OIDC_EMAIL_FROM"]?.trim() || undefined;
  const emailVerifyCodeTtlSeconds = Number(env["OIDC_EMAIL_VERIFY_CODE_TTL_SECONDS"] ?? 600);
  const emailVerifyResendCooldownSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS"] ?? 60
  );
  const emailVerifyMaxAttempts = Number(env["OIDC_EMAIL_VERIFY_MAX_ATTEMPTS"] ?? 5);
  const emailVerifyRateLimitSubjectMax = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX"] ?? 4
  );
  const emailVerifyRateLimitSubjectWindowSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_WINDOW_SECONDS"] ?? 600
  );
  const emailVerifyRateLimitEmailMax = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX"] ?? 2
  );
  const emailVerifyRateLimitEmailWindowSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_WINDOW_SECONDS"] ?? 600
  );
  const emailVerifyRateLimitDomainMax = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX"] ?? 12
  );
  const emailVerifyRateLimitDomainWindowSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_WINDOW_SECONDS"] ?? 600
  );
  const emailVerifyRateLimitIpMax = Number(env["OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX"] ?? 12);
  const emailVerifyRateLimitIpWindowSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_WINDOW_SECONDS"] ?? 600
  );
  const keyEncryptionSecret = requireSecret(env, "OIDC_KEY_ENCRYPTION_SECRET", appEnv === "test");
  const artifactEncryptionSecret = requireSecret(
    env,
    "OIDC_ARTIFACT_ENCRYPTION_SECRET",
    appEnv === "test"
  );
  assertStrongEncryptionSecret(keyEncryptionSecret, "OIDC_KEY_ENCRYPTION_SECRET", appEnv);
  assertStrongEncryptionSecret(
    artifactEncryptionSecret,
    "OIDC_ARTIFACT_ENCRYPTION_SECRET",
    appEnv
  );
  if (artifactEncryptionSecret === keyEncryptionSecret) {
    throw new Error(
      "OIDC_ARTIFACT_ENCRYPTION_SECRET must be different from OIDC_KEY_ENCRYPTION_SECRET"
    );
  }
  const port = Number(env["PORT"] ?? 3003);
  const databaseUrl = env["DATABASE_URL"];
  const redisUrl = env["REDIS_URL"];
  const allowInMemoryStore = env["OIDC_ALLOW_IN_MEMORY_STORE"] === "true" || appEnv === "test";
  const issuer = env["OIDC_ISSUER"] ?? (appEnv === "test" ? `http://127.0.0.1:${port}` : `https://localhost:${port}`);
  assertHttpsOrTestLoopbackHttp(issuer, "OIDC_ISSUER", appEnv);
  const cookieKeysRaw = env["OIDC_COOKIE_KEYS"];
  const parsedCookieKeys = cookieKeysRaw
    ? cookieKeysRaw.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const cookieKeys = parsedCookieKeys.length > 0 ? parsedCookieKeys : [keyEncryptionSecret];
  const oidcClientsConfigPath = env["OIDC_CLIENTS_CONFIG_PATH"]?.trim() || "/app/config/oidc-clients.json";
  const artifactCleanupEnabledRaw = env["OIDC_ARTIFACT_CLEANUP_ENABLED"];
  const artifactCleanupEnabled =
    artifactCleanupEnabledRaw !== undefined ? artifactCleanupEnabledRaw === "true" : true;
  if (!artifactCleanupEnabled) {
    throw new Error("OIDC_ARTIFACT_CLEANUP_ENABLED must be true");
  }
  const sessionTtlSeconds = Number(env["OIDC_SESSION_TTL_SECONDS"] ?? 60 * 60 * 8);
  const sessionIdleTtlSeconds = Number(env["OIDC_SESSION_IDLE_TTL_SECONDS"] ?? 60 * 60 * 2);
  const interactionTtlSeconds = Number(env["OIDC_INTERACTION_TTL_SECONDS"] ?? 60 * 15);
  const csrfSigningSecretRaw = env["OIDC_CSRF_SIGNING_SECRET"]?.trim();
  const csrfSigningSecret = csrfSigningSecretRaw || keyEncryptionSecret;
  const csrfTokenTtlRaw = Number(env["OIDC_CSRF_TOKEN_TTL_SECONDS"] ?? 600);
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error("OIDC_SESSION_TTL_SECONDS must be a positive number");
  }
  if (!Number.isFinite(sessionIdleTtlSeconds) || sessionIdleTtlSeconds <= 0) {
    throw new Error("OIDC_SESSION_IDLE_TTL_SECONDS must be a positive number");
  }
  if (!Number.isInteger(interactionTtlSeconds) || interactionTtlSeconds <= 0) {
    throw new Error("OIDC_INTERACTION_TTL_SECONDS must be a positive integer");
  }
  if (sessionIdleTtlSeconds > sessionTtlSeconds) {
    throw new Error("OIDC_SESSION_IDLE_TTL_SECONDS must be less than or equal to OIDC_SESSION_TTL_SECONDS");
  }
  if (!Number.isInteger(csrfTokenTtlRaw) || csrfTokenTtlRaw <= 0) {
    throw new Error("OIDC_CSRF_TOKEN_TTL_SECONDS must be a positive integer");
  }
  if (!Number.isInteger(emailVerifyCodeTtlSeconds) || emailVerifyCodeTtlSeconds <= 0) {
    throw new Error("OIDC_EMAIL_VERIFY_CODE_TTL_SECONDS must be a positive integer");
  }
  if (
    !Number.isInteger(emailVerifyResendCooldownSeconds) ||
    emailVerifyResendCooldownSeconds <= 0
  ) {
    throw new Error("OIDC_EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS must be a positive integer");
  }
  if (!Number.isInteger(emailVerifyMaxAttempts) || emailVerifyMaxAttempts <= 0) {
    throw new Error("OIDC_EMAIL_VERIFY_MAX_ATTEMPTS must be a positive integer");
  }
  if (!Number.isInteger(emailVerifyRateLimitSubjectMax) || emailVerifyRateLimitSubjectMax <= 0) {
    throw new Error("OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX must be a positive integer");
  }
  if (
    !Number.isInteger(emailVerifyRateLimitSubjectWindowSeconds) ||
    emailVerifyRateLimitSubjectWindowSeconds <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_WINDOW_SECONDS must be a positive integer"
    );
  }
  if (!Number.isInteger(emailVerifyRateLimitEmailMax) || emailVerifyRateLimitEmailMax <= 0) {
    throw new Error("OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX must be a positive integer");
  }
  if (
    !Number.isInteger(emailVerifyRateLimitEmailWindowSeconds) ||
    emailVerifyRateLimitEmailWindowSeconds <= 0
  ) {
    throw new Error("OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_WINDOW_SECONDS must be a positive integer");
  }
  if (!Number.isInteger(emailVerifyRateLimitDomainMax) || emailVerifyRateLimitDomainMax <= 0) {
    throw new Error("OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX must be a positive integer");
  }
  if (
    !Number.isInteger(emailVerifyRateLimitDomainWindowSeconds) ||
    emailVerifyRateLimitDomainWindowSeconds <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_WINDOW_SECONDS must be a positive integer"
    );
  }
  if (!Number.isInteger(emailVerifyRateLimitIpMax) || emailVerifyRateLimitIpMax <= 0) {
    throw new Error("OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX must be a positive integer");
  }
  if (
    !Number.isInteger(emailVerifyRateLimitIpWindowSeconds) ||
    emailVerifyRateLimitIpWindowSeconds <= 0
  ) {
    throw new Error("OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_WINDOW_SECONDS must be a positive integer");
  }
  const csrfTokenTtlSeconds = Math.min(csrfTokenTtlRaw, interactionTtlSeconds);

  const rateLimitFailClosed =
    env["OIDC_RATE_LIMIT_FAIL_CLOSED"] !== undefined
      ? env["OIDC_RATE_LIMIT_FAIL_CLOSED"] === "true"
      : Boolean(redisUrl) && appEnv !== "test";
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
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error("TRUST_PROXY_HOPS must be a non-negative integer");
  }

  const artifactOpportunisticCleanupEnabled =
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_ENABLED"] !== undefined
      ? env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_ENABLED"] === "true"
      : false;
  const artifactOpportunisticCleanupSampleRate = Number(
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_SAMPLE_RATE"] ?? 0.05
  );
  const artifactOpportunisticCleanupBatchSize = Number(
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_BATCH_SIZE"] ?? 1000
  );
  const artifactOpportunisticCleanupIntervalSeconds = Number(
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_INTERVAL_SECONDS"] ?? 10
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
  const signingKeyRefreshIntervalSeconds = Number(
    env["OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS"] ?? 30
  );
  if (!Number.isInteger(signingKeyRefreshIntervalSeconds) || signingKeyRefreshIntervalSeconds <= 0) {
    throw new Error("OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS must be a positive integer");
  }

  const artifactCleanupCron = env["OIDC_ARTIFACT_CLEANUP_CRON"] ?? "*/5 * * * *";
  const artifactCleanupBatchSize = Number(env["OIDC_ARTIFACT_CLEANUP_BATCH_SIZE"] ?? 5000);
  if (!Number.isInteger(artifactCleanupBatchSize) || artifactCleanupBatchSize <= 0) {
    throw new Error("OIDC_ARTIFACT_CLEANUP_BATCH_SIZE must be a positive integer");
  }
  const authProvider = env["AUTH_PROVIDER"] ?? "cqut";
  if (isProduction && authProvider === "mock") {
    throw new Error("AUTH_PROVIDER=mock is not allowed in production");
  }
  if (isProduction) {
    if (parsedCookieKeys.length === 0) {
      throw new Error("OIDC_COOKIE_KEYS is required when APP_ENV=production");
    }
    if (!csrfSigningSecretRaw) {
      throw new Error("OIDC_CSRF_SIGNING_SECRET is required when APP_ENV=production");
    }
    if (csrfSigningSecret === keyEncryptionSecret) {
      throw new Error("OIDC_CSRF_SIGNING_SECRET must be different from OIDC_KEY_ENCRYPTION_SECRET");
    }
    if (cookieKeys.some((value) => value === keyEncryptionSecret)) {
      throw new Error("OIDC_COOKIE_KEYS entries must be different from OIDC_KEY_ENCRYPTION_SECRET");
    }
    if (cookieKeys.some((value) => value === csrfSigningSecret)) {
      throw new Error("OIDC_COOKIE_KEYS entries must be different from OIDC_CSRF_SIGNING_SECRET");
    }
    if (allowInMemoryStore) {
      throw new Error("OIDC_ALLOW_IN_MEMORY_STORE=true is not allowed when APP_ENV=production");
    }
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when APP_ENV=production");
    }
    if (!redisUrl) {
      throw new Error("REDIS_URL is required when APP_ENV=production");
    }
    if (!rateLimitFailClosed) {
      throw new Error("OIDC_RATE_LIMIT_FAIL_CLOSED must be true when APP_ENV=production");
    }
    if (trustProxyHops !== 1) {
      throw new Error("TRUST_PROXY_HOPS must be 1 when APP_ENV=production");
    }
    if (emailVerificationEnabled && !resendApiKey) {
      throw new Error("RESEND_API_KEY is required when APP_ENV=production and email verification is enabled");
    }
    if (emailVerificationEnabled && !emailFrom) {
      throw new Error("OIDC_EMAIL_FROM is required when APP_ENV=production and email verification is enabled");
    }
  }
  return {
    port,
    appEnv,
    isProduction,
    trustProxyHops,
    issuer,
    schoolCode: env["SCHOOL_CODE"] ?? "cqut",
    authProvider,
    emailVerificationEnabled,
    resendApiKey,
    emailFrom,
    emailVerifyCodeTtlSeconds,
    emailVerifyResendCooldownSeconds,
    emailVerifyMaxAttempts,
    emailVerifyRateLimitSubjectMax,
    emailVerifyRateLimitSubjectWindowSeconds,
    emailVerifyRateLimitEmailMax,
    emailVerifyRateLimitEmailWindowSeconds,
    emailVerifyRateLimitDomainMax,
    emailVerifyRateLimitDomainWindowSeconds,
    emailVerifyRateLimitIpMax,
    emailVerifyRateLimitIpWindowSeconds,
    providerTimeoutMs: Number(env["PROVIDER_TIMEOUT_MS"] ?? 10000),
    providerTotalTimeoutMs: Number(env["PROVIDER_TOTAL_TIMEOUT_MS"] ?? 20000),
    cqutUisBaseUrl: (env["CQUT_UIS_BASE_URL"] ?? "https://uis.cqut.edu.cn").replace(/\/$/, ""),
    cqutCasApplicationCode: env["CQUT_CAS_APPLICATION_CODE"] ?? "officeHallApplicationCode",
    cqutCasServiceUrl:
      env["CQUT_CAS_SERVICE_URL"] ??
      "https://uis.cqut.edu.cn/ump/common/login/authSourceAuth/auth?applicationCode=officeHallApplicationCode",
    databaseUrl,
    redisUrl,
    allowInMemoryStore,
    cookieKeys,
    keyEncryptionSecret,
    artifactEncryptionSecret,
    cookieSecure: env["OIDC_COOKIE_SECURE"] !== undefined ? env["OIDC_COOKIE_SECURE"] !== "false" : appEnv !== "test",
    csrfSigningSecret,
    csrfTokenTtlSeconds,
    sessionTtlSeconds,
    sessionIdleTtlSeconds,
    interactionTtlSeconds,
    authorizationCodeTtlSeconds: Number(env["OIDC_AUTHORIZATION_CODE_TTL_SECONDS"] ?? 60),
    accessTokenTtlSeconds: Number(env["OIDC_ACCESS_TOKEN_TTL_SECONDS"] ?? 60 * 5),
    idTokenTtlSeconds: Number(env["OIDC_ID_TOKEN_TTL_SECONDS"] ?? 60 * 5),
    refreshTokenTtlSeconds: Number(env["OIDC_REFRESH_TTL_SECONDS"] ?? 60 * 60 * 24 * 30),
    artifactCleanupEnabled,
    artifactCleanupCron,
    artifactCleanupBatchSize,
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
    signingKeyRefreshIntervalSeconds,
    oidcClientsConfigPath,
    autoSeedSigningKey:
      env["OIDC_AUTO_SEED_SIGNING_KEY"] !== undefined
        ? env["OIDC_AUTO_SEED_SIGNING_KEY"] === "true"
        : appEnv === "test"
  };
}
