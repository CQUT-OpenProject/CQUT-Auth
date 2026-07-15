export type OidcOpConfig = {
  port: number;
  appEnv: string;
  isProduction: boolean;
  trustProxyHops: number;
  trustedProxyCidrs: string[];
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
  grantTtlSeconds: number;
  artifactCleanupEnabled: boolean;
  artifactCleanupCron: string;
  artifactCleanupBatchSize: number;
  loginRateLimitMax: number;
  loginRateLimitWindowSeconds: number;
  loginFailureLimit: number;
  loginFailureWindowSeconds: number;
  tokenRateLimitMax: number;
  tokenRateLimitWindowSeconds: number;
  managementProjectMaxActivePerSubject: number;
  managementProjectCreateRateLimitSubjectMax: number;
  managementProjectCreateRateLimitIpMax: number;
  managementProjectCreateRateLimitWindowSeconds: number;
  managementProjectQuotaAdminExempt: boolean;
  managementClientMaxPerProject: number;
  managementClientMaxPendingPerProject: number;
  managementClientMaxPerSubject: number;
  managementClientMaxPendingPerSubject: number;
  managementClientCreateRateLimitSubjectMax: number;
  managementClientCreateRateLimitIpMax: number;
  managementClientCreateRateLimitWindowSeconds: number;
  managementClientQuotaAdminExempt: boolean;
  clientSecretDefaultGraceSeconds: number;
  clientSecretMaxGraceSeconds: number;
  clientSecretRotateRateLimitSubjectMax: number;
  clientSecretRotateRateLimitClientMax: number;
  clientSecretRotateRateLimitIpMax: number;
  clientSecretRotateRateLimitWindowSeconds: number;
  clientSecretRotateMinimumIntervalSeconds: number;
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
  adminSubjectIds: string[];
};

function requireSecret(
  env: NodeJS.ProcessEnv,
  key: string,
  allowDefaultForTest = false,
): string {
  const value = env[key];
  if (value) {
    return value;
  }
  if (allowDefaultForTest) {
    return `test-${key.toLowerCase()}`;
  }
  throw new Error(`${key} is required`);
}
function parseCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function assertStrongEncryptionSecret(
  secret: string,
  key: string,
  appEnv: string,
) {
  if (appEnv === "test") {
    return;
  }
  if (secret.length < 32) {
    throw new Error(
      `${key} must be at least 32 characters and generated from high-entropy randomness`,
    );
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

function assertHttpsOrTestLoopbackHttp(
  value: string,
  key: string,
  appEnv: string,
) {
  const parsed = parseAbsoluteUrl(value, key);
  if (parsed.protocol === "https:") {
    return;
  }
  if (
    appEnv === "test" &&
    parsed.protocol === "http:" &&
    isLoopbackHostname(parsed.hostname)
  ) {
    return;
  }
  if (appEnv === "test") {
    throw new Error(
      `${key} must use https:// or loopback http://localhost|127.0.0.1 in test`,
    );
  }
  throw new Error(`${key} must use https:// when APP_ENV is not test`);
}

export function readOidcOpConfig(
  env: NodeJS.ProcessEnv = process.env,
): OidcOpConfig {
  // Business policy is persisted in app_settings and loaded after database
  // initialization. Keep legacy variables from influencing bootstrap defaults.
  env = { ...env };
  for (const key of MIGRATED_RUNTIME_POLICY_ENV_KEYS) {
    delete env[key];
  }
  const appEnv = env["APP_ENV"] ?? env["NODE_ENV"] ?? "development";
  const isProduction = appEnv === "production";
  const trustProxyHops = Number(
    env["TRUST_PROXY_HOPS"] ?? (isProduction ? 1 : 0),
  );
  const trustedProxyCidrs = parseCsv(
    env["TRUSTED_PROXY_CIDRS"] ??
      (trustProxyHops > 0
        ? "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7"
        : ""),
  );
  const emailVerificationEnabled =
    env["OIDC_EMAIL_VERIFICATION_ENABLED"] !== "false";
  if (isProduction && !emailVerificationEnabled) {
    throw new Error(
      "OIDC_EMAIL_VERIFICATION_ENABLED must remain enabled when APP_ENV=production",
    );
  }
  const resendApiKey = env["RESEND_API_KEY"]?.trim() || undefined;
  const emailFrom = env["OIDC_EMAIL_FROM"]?.trim() || undefined;
  const emailVerifyCodeTtlSeconds = Number(
    env["OIDC_EMAIL_VERIFY_CODE_TTL_SECONDS"] ?? 600,
  );
  const emailVerifyResendCooldownSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS"] ?? 60,
  );
  const emailVerifyMaxAttempts = Number(
    env["OIDC_EMAIL_VERIFY_MAX_ATTEMPTS"] ?? 5,
  );
  const emailVerifyRateLimitSubjectMax = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX"] ?? 4,
  );
  const emailVerifyRateLimitSubjectWindowSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_WINDOW_SECONDS"] ?? 600,
  );
  const emailVerifyRateLimitEmailMax = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX"] ?? 2,
  );
  const emailVerifyRateLimitEmailWindowSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_WINDOW_SECONDS"] ?? 600,
  );
  const emailVerifyRateLimitDomainMax = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX"] ?? 12,
  );
  const emailVerifyRateLimitDomainWindowSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_WINDOW_SECONDS"] ?? 600,
  );
  const emailVerifyRateLimitIpMax = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX"] ?? 12,
  );
  const emailVerifyRateLimitIpWindowSeconds = Number(
    env["OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_WINDOW_SECONDS"] ?? 600,
  );
  const keyEncryptionSecret = requireSecret(
    env,
    "OIDC_KEY_ENCRYPTION_SECRET",
    appEnv === "test",
  );
  const artifactEncryptionSecret = requireSecret(
    env,
    "OIDC_ARTIFACT_ENCRYPTION_SECRET",
    appEnv === "test",
  );
  assertStrongEncryptionSecret(
    keyEncryptionSecret,
    "OIDC_KEY_ENCRYPTION_SECRET",
    appEnv,
  );
  assertStrongEncryptionSecret(
    artifactEncryptionSecret,
    "OIDC_ARTIFACT_ENCRYPTION_SECRET",
    appEnv,
  );
  if (artifactEncryptionSecret === keyEncryptionSecret) {
    throw new Error(
      "OIDC_ARTIFACT_ENCRYPTION_SECRET must be different from OIDC_KEY_ENCRYPTION_SECRET",
    );
  }
  const port = Number(env["PORT"] ?? 3003);
  const databaseUrl = env["DATABASE_URL"];
  const redisUrl = env["REDIS_URL"];
  const allowInMemoryStore =
    env["OIDC_ALLOW_IN_MEMORY_STORE"] === "true" || appEnv === "test";
  const issuer =
    env["OIDC_ISSUER"] ??
    (appEnv === "test"
      ? `http://127.0.0.1:${port}`
      : `https://localhost:${port}`);
  assertHttpsOrTestLoopbackHttp(issuer, "OIDC_ISSUER", appEnv);
  const cookieKeysRaw = env["OIDC_COOKIE_KEYS"];
  const parsedCookieKeys = cookieKeysRaw
    ? cookieKeysRaw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const cookieKeys =
    parsedCookieKeys.length > 0 ? parsedCookieKeys : [keyEncryptionSecret];
  const oidcClientsConfigPath =
    env["OIDC_CLIENTS_CONFIG_PATH"]?.trim() || "/app/config/oidc-clients.json";
  const artifactCleanupEnabledRaw = env["OIDC_ARTIFACT_CLEANUP_ENABLED"];
  const artifactCleanupEnabled =
    artifactCleanupEnabledRaw !== undefined
      ? artifactCleanupEnabledRaw === "true"
      : true;
  if (!artifactCleanupEnabled) {
    throw new Error("OIDC_ARTIFACT_CLEANUP_ENABLED must be true");
  }
  const sessionTtlSeconds = Number(
    env["OIDC_SESSION_TTL_SECONDS"] ?? 60 * 60 * 8,
  );
  const sessionIdleTtlSeconds = Number(
    env["OIDC_SESSION_IDLE_TTL_SECONDS"] ?? 60 * 60 * 2,
  );
  const interactionTtlSeconds = Number(
    env["OIDC_INTERACTION_TTL_SECONDS"] ?? 60 * 15,
  );
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
    throw new Error(
      "OIDC_SESSION_IDLE_TTL_SECONDS must be less than or equal to OIDC_SESSION_TTL_SECONDS",
    );
  }
  if (!Number.isInteger(csrfTokenTtlRaw) || csrfTokenTtlRaw <= 0) {
    throw new Error("OIDC_CSRF_TOKEN_TTL_SECONDS must be a positive integer");
  }
  if (
    !Number.isInteger(emailVerifyCodeTtlSeconds) ||
    emailVerifyCodeTtlSeconds <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_CODE_TTL_SECONDS must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyResendCooldownSeconds) ||
    emailVerifyResendCooldownSeconds <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyMaxAttempts) ||
    emailVerifyMaxAttempts <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_MAX_ATTEMPTS must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyRateLimitSubjectMax) ||
    emailVerifyRateLimitSubjectMax <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyRateLimitSubjectWindowSeconds) ||
    emailVerifyRateLimitSubjectWindowSeconds <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_WINDOW_SECONDS must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyRateLimitEmailMax) ||
    emailVerifyRateLimitEmailMax <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyRateLimitEmailWindowSeconds) ||
    emailVerifyRateLimitEmailWindowSeconds <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_WINDOW_SECONDS must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyRateLimitDomainMax) ||
    emailVerifyRateLimitDomainMax <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyRateLimitDomainWindowSeconds) ||
    emailVerifyRateLimitDomainWindowSeconds <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_WINDOW_SECONDS must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyRateLimitIpMax) ||
    emailVerifyRateLimitIpMax <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX must be a positive integer",
    );
  }
  if (
    !Number.isInteger(emailVerifyRateLimitIpWindowSeconds) ||
    emailVerifyRateLimitIpWindowSeconds <= 0
  ) {
    throw new Error(
      "OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_WINDOW_SECONDS must be a positive integer",
    );
  }
  const csrfTokenTtlSeconds = Math.min(csrfTokenTtlRaw, interactionTtlSeconds);

  const rateLimitFailClosed =
    env["OIDC_RATE_LIMIT_FAIL_CLOSED"] !== undefined
      ? env["OIDC_RATE_LIMIT_FAIL_CLOSED"] === "true"
      : Boolean(redisUrl) && appEnv !== "test";
  const rateLimitMemoryMaxKeys = Number(
    env["OIDC_RATE_LIMIT_MEMORY_MAX_KEYS"] ?? 10000,
  );
  const rateLimitMemoryCleanupIntervalSeconds = Number(
    env["OIDC_RATE_LIMIT_MEMORY_CLEANUP_INTERVAL_SECONDS"] ?? 60,
  );
  if (
    !Number.isInteger(rateLimitMemoryMaxKeys) ||
    rateLimitMemoryMaxKeys <= 0
  ) {
    throw new Error(
      "OIDC_RATE_LIMIT_MEMORY_MAX_KEYS must be a positive integer",
    );
  }
  if (
    !Number.isInteger(rateLimitMemoryCleanupIntervalSeconds) ||
    rateLimitMemoryCleanupIntervalSeconds <= 0
  ) {
    throw new Error(
      "OIDC_RATE_LIMIT_MEMORY_CLEANUP_INTERVAL_SECONDS must be a positive integer",
    );
  }
  const managementClientMaxPerProject = Number(
    env["OIDC_MANAGEMENT_CLIENT_MAX_PER_PROJECT"] ?? 10,
  );
  const managementClientMaxPendingPerProject = Number(
    env["OIDC_MANAGEMENT_CLIENT_MAX_PENDING_PER_PROJECT"] ?? 5,
  );
  const managementClientMaxPerSubject = Number(
    env["OIDC_MANAGEMENT_CLIENT_MAX_PER_SUBJECT"] ?? 30,
  );
  const managementClientMaxPendingPerSubject = Number(
    env["OIDC_MANAGEMENT_CLIENT_MAX_PENDING_PER_SUBJECT"] ?? 15,
  );
  const managementProjectMaxActivePerSubject = Number(
    env["OIDC_MANAGEMENT_PROJECT_MAX_ACTIVE_PER_SUBJECT"] ?? 5,
  );
  const managementProjectCreateRateLimitSubjectMax = Number(
    env["OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_SUBJECT_MAX"] ?? 3,
  );
  const managementProjectCreateRateLimitIpMax = Number(
    env["OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_IP_MAX"] ?? 10,
  );
  const managementProjectCreateRateLimitWindowSeconds = Number(
    env["OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_WINDOW_SECONDS"] ?? 3600,
  );
  const managementClientCreateRateLimitSubjectMax = Number(
    env["OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_SUBJECT_MAX"] ?? 5,
  );
  const managementClientCreateRateLimitIpMax = Number(
    env["OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_IP_MAX"] ?? 20,
  );
  const managementClientCreateRateLimitWindowSeconds = Number(
    env["OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_WINDOW_SECONDS"] ?? 3600,
  );
  const clientSecretDefaultGraceSeconds = Number(
    env["OIDC_CLIENT_SECRET_DEFAULT_GRACE_SECONDS"] ?? 86_400,
  );
  const clientSecretMaxGraceSeconds = Number(
    env["OIDC_CLIENT_SECRET_MAX_GRACE_SECONDS"] ?? 604_800,
  );
  const clientSecretRotateRateLimitSubjectMax = Number(
    env["OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_SUBJECT_MAX"] ?? 10,
  );
  const clientSecretRotateRateLimitClientMax = Number(
    env["OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_CLIENT_MAX"] ?? 5,
  );
  const clientSecretRotateRateLimitIpMax = Number(
    env["OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_IP_MAX"] ?? 20,
  );
  const clientSecretRotateRateLimitWindowSeconds = Number(
    env["OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_WINDOW_SECONDS"] ?? 3600,
  );
  const clientSecretRotateMinimumIntervalSeconds = Number(
    env["OIDC_CLIENT_SECRET_ROTATE_MINIMUM_INTERVAL_SECONDS"] ?? 60,
  );
  if (
    !Number.isInteger(clientSecretDefaultGraceSeconds) ||
    !Number.isInteger(clientSecretMaxGraceSeconds) ||
    clientSecretDefaultGraceSeconds < 0 ||
    clientSecretMaxGraceSeconds < 0 ||
    clientSecretDefaultGraceSeconds > clientSecretMaxGraceSeconds
  ) {
    throw new Error(
      "OIDC client secret grace values must be non-negative integers and default must not exceed max",
    );
  }
  for (const [key, value] of [
    ["OIDC_MANAGEMENT_CLIENT_MAX_PER_PROJECT", managementClientMaxPerProject],
    ["OIDC_MANAGEMENT_CLIENT_MAX_PER_SUBJECT", managementClientMaxPerSubject],
    [
      "OIDC_MANAGEMENT_CLIENT_MAX_PENDING_PER_PROJECT",
      managementClientMaxPendingPerProject,
    ],
    [
      "OIDC_MANAGEMENT_CLIENT_MAX_PENDING_PER_SUBJECT",
      managementClientMaxPendingPerSubject,
    ],
    [
      "OIDC_MANAGEMENT_PROJECT_MAX_ACTIVE_PER_SUBJECT",
      managementProjectMaxActivePerSubject,
    ],
    [
      "OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_SUBJECT_MAX",
      managementProjectCreateRateLimitSubjectMax,
    ],
    [
      "OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_IP_MAX",
      managementProjectCreateRateLimitIpMax,
    ],
    [
      "OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_WINDOW_SECONDS",
      managementProjectCreateRateLimitWindowSeconds,
    ],
    [
      "OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_SUBJECT_MAX",
      managementClientCreateRateLimitSubjectMax,
    ],
    [
      "OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_IP_MAX",
      managementClientCreateRateLimitIpMax,
    ],
    [
      "OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_WINDOW_SECONDS",
      managementClientCreateRateLimitWindowSeconds,
    ],
    [
      "OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_SUBJECT_MAX",
      clientSecretRotateRateLimitSubjectMax,
    ],
    [
      "OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_CLIENT_MAX",
      clientSecretRotateRateLimitClientMax,
    ],
    [
      "OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_IP_MAX",
      clientSecretRotateRateLimitIpMax,
    ],
    [
      "OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_WINDOW_SECONDS",
      clientSecretRotateRateLimitWindowSeconds,
    ],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  if (
    !Number.isInteger(clientSecretRotateMinimumIntervalSeconds) ||
    clientSecretRotateMinimumIntervalSeconds < 0
  ) {
    throw new Error(
      "OIDC_CLIENT_SECRET_ROTATE_MINIMUM_INTERVAL_SECONDS must be a non-negative integer",
    );
  }
  if (managementClientMaxPendingPerProject > managementClientMaxPerProject) {
    throw new Error(
      "OIDC_MANAGEMENT_CLIENT_MAX_PENDING_PER_PROJECT must not exceed OIDC_MANAGEMENT_CLIENT_MAX_PER_PROJECT",
    );
  }
  if (managementClientMaxPendingPerSubject > managementClientMaxPerSubject) {
    throw new Error(
      "OIDC_MANAGEMENT_CLIENT_MAX_PENDING_PER_SUBJECT must not exceed OIDC_MANAGEMENT_CLIENT_MAX_PER_SUBJECT",
    );
  }
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error("TRUST_PROXY_HOPS must be a non-negative integer");
  }
  if (trustProxyHops > 0 && trustedProxyCidrs.length === 0) {
    throw new Error(
      "TRUSTED_PROXY_CIDRS must contain at least one CIDR when TRUST_PROXY_HOPS is enabled",
    );
  }

  const artifactOpportunisticCleanupEnabled =
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_ENABLED"] !== undefined
      ? env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_ENABLED"] === "true"
      : false;
  const artifactOpportunisticCleanupSampleRate = Number(
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_SAMPLE_RATE"] ?? 0.05,
  );
  const artifactOpportunisticCleanupBatchSize = Number(
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_BATCH_SIZE"] ?? 1000,
  );
  const artifactOpportunisticCleanupIntervalSeconds = Number(
    env["OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_INTERVAL_SECONDS"] ?? 10,
  );
  if (
    !Number.isFinite(artifactOpportunisticCleanupSampleRate) ||
    artifactOpportunisticCleanupSampleRate < 0 ||
    artifactOpportunisticCleanupSampleRate > 1
  ) {
    throw new Error(
      "OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_SAMPLE_RATE must be between 0 and 1",
    );
  }
  if (
    !Number.isInteger(artifactOpportunisticCleanupBatchSize) ||
    artifactOpportunisticCleanupBatchSize <= 0
  ) {
    throw new Error(
      "OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_BATCH_SIZE must be a positive integer",
    );
  }
  if (
    !Number.isInteger(artifactOpportunisticCleanupIntervalSeconds) ||
    artifactOpportunisticCleanupIntervalSeconds <= 0
  ) {
    throw new Error(
      "OIDC_ARTIFACT_OPPORTUNISTIC_CLEANUP_INTERVAL_SECONDS must be a positive integer",
    );
  }
  const signingKeyRefreshIntervalSeconds = Number(
    env["OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS"] ?? 30,
  );
  if (
    !Number.isInteger(signingKeyRefreshIntervalSeconds) ||
    signingKeyRefreshIntervalSeconds <= 0
  ) {
    throw new Error(
      "OIDC_SIGNING_KEY_REFRESH_INTERVAL_SECONDS must be a positive integer",
    );
  }

  const artifactCleanupCron =
    env["OIDC_ARTIFACT_CLEANUP_CRON"] ?? "*/5 * * * *";
  const artifactCleanupBatchSize = Number(
    env["OIDC_ARTIFACT_CLEANUP_BATCH_SIZE"] ?? 5000,
  );
  if (
    !Number.isInteger(artifactCleanupBatchSize) ||
    artifactCleanupBatchSize <= 0
  ) {
    throw new Error(
      "OIDC_ARTIFACT_CLEANUP_BATCH_SIZE must be a positive integer",
    );
  }
  const authProvider = env["AUTH_PROVIDER"] ?? "cqut";
  if (authProvider === "mock" && appEnv !== "test") {
    throw new Error("AUTH_PROVIDER=mock is only allowed when APP_ENV=test");
  }
  if (isProduction) {
    if (parsedCookieKeys.length === 0) {
      throw new Error("OIDC_COOKIE_KEYS is required when APP_ENV=production");
    }
    if (!csrfSigningSecretRaw) {
      throw new Error(
        "OIDC_CSRF_SIGNING_SECRET is required when APP_ENV=production",
      );
    }
    if (csrfSigningSecret === keyEncryptionSecret) {
      throw new Error(
        "OIDC_CSRF_SIGNING_SECRET must be different from OIDC_KEY_ENCRYPTION_SECRET",
      );
    }
    if (cookieKeys.some((value) => value === keyEncryptionSecret)) {
      throw new Error(
        "OIDC_COOKIE_KEYS entries must be different from OIDC_KEY_ENCRYPTION_SECRET",
      );
    }
    if (cookieKeys.some((value) => value === csrfSigningSecret)) {
      throw new Error(
        "OIDC_COOKIE_KEYS entries must be different from OIDC_CSRF_SIGNING_SECRET",
      );
    }
    if (allowInMemoryStore) {
      throw new Error(
        "OIDC_ALLOW_IN_MEMORY_STORE=true is not allowed when APP_ENV=production",
      );
    }
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when APP_ENV=production");
    }
    if (!redisUrl) {
      throw new Error("REDIS_URL is required when APP_ENV=production");
    }
    if (!rateLimitFailClosed) {
      throw new Error(
        "OIDC_RATE_LIMIT_FAIL_CLOSED must be true when APP_ENV=production",
      );
    }
    if (trustProxyHops !== 1) {
      throw new Error("TRUST_PROXY_HOPS must be 1 when APP_ENV=production");
    }
    if (trustedProxyCidrs.length === 0) {
      throw new Error(
        "TRUSTED_PROXY_CIDRS must contain at least one CIDR when APP_ENV=production",
      );
    }
  }
  const refreshTokenTtlSeconds = Number(
    env["OIDC_REFRESH_TTL_SECONDS"] ?? 60 * 60 * 24 * 30,
  );
  if (
    !Number.isInteger(refreshTokenTtlSeconds) ||
    refreshTokenTtlSeconds <= 0
  ) {
    throw new Error("OIDC_REFRESH_TTL_SECONDS must be a positive integer");
  }
  // The Grant anchors consent and outlives individual refresh tokens; under
  // refresh-token rotation the grant must not expire before a still-valid
  // rotated refresh token, so it defaults to (and is enforced ≥) the refresh TTL.
  const grantTtlSeconds = Number(
    env["OIDC_GRANT_TTL_SECONDS"] ?? 60 * 60 * 24 * 90,
  );
  if (!Number.isInteger(grantTtlSeconds) || grantTtlSeconds <= 0) {
    throw new Error("OIDC_GRANT_TTL_SECONDS must be a positive integer");
  }
  if (grantTtlSeconds < refreshTokenTtlSeconds) {
    throw new Error(
      "OIDC_GRANT_TTL_SECONDS must be greater than or equal to OIDC_REFRESH_TTL_SECONDS",
    );
  }
  return {
    port,
    appEnv,
    isProduction,
    trustProxyHops,
    trustedProxyCidrs,
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
    cqutUisBaseUrl: (
      env["CQUT_UIS_BASE_URL"] ?? "https://uis.cqut.edu.cn"
    ).replace(/\/$/, ""),
    cqutCasApplicationCode:
      env["CQUT_CAS_APPLICATION_CODE"] ?? "officeHallApplicationCode",
    cqutCasServiceUrl:
      env["CQUT_CAS_SERVICE_URL"] ??
      "https://uis.cqut.edu.cn/ump/common/login/authSourceAuth/auth?applicationCode=officeHallApplicationCode",
    databaseUrl,
    redisUrl,
    allowInMemoryStore,
    cookieKeys,
    keyEncryptionSecret,
    artifactEncryptionSecret,
    cookieSecure:
      env["OIDC_COOKIE_SECURE"] !== undefined
        ? env["OIDC_COOKIE_SECURE"] !== "false"
        : appEnv !== "test",
    csrfSigningSecret,
    csrfTokenTtlSeconds,
    sessionTtlSeconds,
    sessionIdleTtlSeconds,
    interactionTtlSeconds,
    authorizationCodeTtlSeconds: Number(
      env["OIDC_AUTHORIZATION_CODE_TTL_SECONDS"] ?? 60,
    ),
    accessTokenTtlSeconds: Number(
      env["OIDC_ACCESS_TOKEN_TTL_SECONDS"] ?? 60 * 5,
    ),
    idTokenTtlSeconds: Number(env["OIDC_ID_TOKEN_TTL_SECONDS"] ?? 60 * 5),
    refreshTokenTtlSeconds,
    grantTtlSeconds,
    artifactCleanupEnabled,
    artifactCleanupCron,
    artifactCleanupBatchSize,
    loginRateLimitMax: Number(env["OIDC_LOGIN_RATE_LIMIT_MAX"] ?? 10),
    loginRateLimitWindowSeconds: Number(
      env["OIDC_LOGIN_RATE_LIMIT_WINDOW_SECONDS"] ?? 60,
    ),
    loginFailureLimit: Number(env["OIDC_LOGIN_FAILURE_LIMIT"] ?? 5),
    loginFailureWindowSeconds: Number(
      env["OIDC_LOGIN_FAILURE_WINDOW_SECONDS"] ?? 60 * 5,
    ),
    tokenRateLimitMax: Number(env["OIDC_TOKEN_RATE_LIMIT_MAX"] ?? 20),
    tokenRateLimitWindowSeconds: Number(
      env["OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS"] ?? 60,
    ),
    managementProjectMaxActivePerSubject,
    managementProjectCreateRateLimitSubjectMax,
    managementProjectCreateRateLimitIpMax,
    managementProjectCreateRateLimitWindowSeconds,
    managementProjectQuotaAdminExempt:
      env["OIDC_MANAGEMENT_PROJECT_QUOTA_ADMIN_EXEMPT"] !== "false",
    managementClientMaxPerProject,
    managementClientMaxPendingPerProject,
    managementClientMaxPerSubject,
    managementClientMaxPendingPerSubject,
    managementClientCreateRateLimitSubjectMax,
    managementClientCreateRateLimitIpMax,
    managementClientCreateRateLimitWindowSeconds,
    managementClientQuotaAdminExempt:
      env["OIDC_MANAGEMENT_CLIENT_QUOTA_ADMIN_EXEMPT"] !== "false",
    clientSecretDefaultGraceSeconds,
    clientSecretMaxGraceSeconds,
    clientSecretRotateRateLimitSubjectMax,
    clientSecretRotateRateLimitClientMax,
    clientSecretRotateRateLimitIpMax,
    clientSecretRotateRateLimitWindowSeconds,
    clientSecretRotateMinimumIntervalSeconds,
    rateLimitFailClosed,
    rateLimitMemoryMaxKeys,
    rateLimitMemoryCleanupIntervalSeconds,
    artifactOpportunisticCleanupEnabled,
    artifactOpportunisticCleanupSampleRate,
    artifactOpportunisticCleanupBatchSize,
    artifactOpportunisticCleanupIntervalSeconds,
    signingKeyRefreshIntervalSeconds,
    oidcClientsConfigPath,
    adminSubjectIds: parseCsv(env["OIDC_ADMIN_SUBJECT_IDS"]),
    autoSeedSigningKey:
      env["OIDC_AUTO_SEED_SIGNING_KEY"] !== undefined
        ? env["OIDC_AUTO_SEED_SIGNING_KEY"] === "true"
        : appEnv === "test",
  };
}

const MIGRATED_RUNTIME_POLICY_ENV_KEYS = [
  "RESEND_API_KEY",
  "OIDC_EMAIL_FROM",
  "OIDC_CSRF_TOKEN_TTL_SECONDS",
  "OIDC_SESSION_TTL_SECONDS",
  "OIDC_SESSION_IDLE_TTL_SECONDS",
  "OIDC_INTERACTION_TTL_SECONDS",
  "OIDC_AUTHORIZATION_CODE_TTL_SECONDS",
  "OIDC_ACCESS_TOKEN_TTL_SECONDS",
  "OIDC_ID_TOKEN_TTL_SECONDS",
  "OIDC_REFRESH_TTL_SECONDS",
  "OIDC_GRANT_TTL_SECONDS",
  "OIDC_EMAIL_VERIFY_CODE_TTL_SECONDS",
  "OIDC_EMAIL_VERIFY_RESEND_COOLDOWN_SECONDS",
  "OIDC_EMAIL_VERIFY_MAX_ATTEMPTS",
  "OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX",
  "OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_WINDOW_SECONDS",
  "OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX",
  "OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_WINDOW_SECONDS",
  "OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX",
  "OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_WINDOW_SECONDS",
  "OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX",
  "OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_WINDOW_SECONDS",
  "OIDC_LOGIN_RATE_LIMIT_MAX",
  "OIDC_LOGIN_RATE_LIMIT_WINDOW_SECONDS",
  "OIDC_LOGIN_FAILURE_LIMIT",
  "OIDC_LOGIN_FAILURE_WINDOW_SECONDS",
  "OIDC_TOKEN_RATE_LIMIT_MAX",
  "OIDC_TOKEN_RATE_LIMIT_WINDOW_SECONDS",
  "OIDC_MANAGEMENT_PROJECT_MAX_ACTIVE_PER_SUBJECT",
  "OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_SUBJECT_MAX",
  "OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_IP_MAX",
  "OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_WINDOW_SECONDS",
  "OIDC_MANAGEMENT_PROJECT_QUOTA_ADMIN_EXEMPT",
  "OIDC_MANAGEMENT_CLIENT_MAX_PER_PROJECT",
  "OIDC_MANAGEMENT_CLIENT_MAX_PENDING_PER_PROJECT",
  "OIDC_MANAGEMENT_CLIENT_MAX_PER_SUBJECT",
  "OIDC_MANAGEMENT_CLIENT_MAX_PENDING_PER_SUBJECT",
  "OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_SUBJECT_MAX",
  "OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_IP_MAX",
  "OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_WINDOW_SECONDS",
  "OIDC_MANAGEMENT_CLIENT_QUOTA_ADMIN_EXEMPT",
  "OIDC_CLIENT_SECRET_DEFAULT_GRACE_SECONDS",
  "OIDC_CLIENT_SECRET_MAX_GRACE_SECONDS",
  "OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_SUBJECT_MAX",
  "OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_CLIENT_MAX",
  "OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_IP_MAX",
  "OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_WINDOW_SECONDS",
  "OIDC_CLIENT_SECRET_ROTATE_MINIMUM_INTERVAL_SECONDS",
] as const;
