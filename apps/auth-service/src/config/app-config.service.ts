import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type WorkerMode = "inline" | "external";

@Injectable()
export class AppConfigService {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {}

  get port(): number {
    return Number(this.configService.get("PORT", 3001));
  }

  get appEnv(): string {
    return this.configService.get("APP_ENV", "development");
  }

  get isProduction(): boolean {
    return this.appEnv === "production";
  }

  get startupStrictDependencies(): boolean {
    const explicit = this.configService.get<string>("STARTUP_STRICT_DEPENDENCIES");
    if (explicit !== undefined) {
      return explicit.toLowerCase() !== "false";
    }
    return this.appEnv === "production";
  }

  get workerMode(): WorkerMode {
    const mode = this.configService.get<string>("WORKER_MODE");
    return mode === "external" ? "external" : "inline";
  }

  get inlineWorkerEnabled(): boolean {
    if (this.workerMode !== "inline") {
      return false;
    }

    const explicit = this.configService.get<string>("WORKER_INLINE_ENABLED");
    if (explicit !== undefined) {
      return explicit.toLowerCase() !== "false";
    }
    return true;
  }

  get databaseRequired(): boolean {
    return this.workerMode === "external" || this.startupStrictDependencies;
  }

  get redisRequiredAtStartup(): boolean {
    return this.startupStrictDependencies && this.verifyRateLimitEnabled && !!this.redisUrl;
  }

  get redisRequiredForReadiness(): boolean {
    return this.verifyRateLimitEnabled && !!this.redisUrl;
  }

  get schoolCode(): string {
    return this.configService.get("SCHOOL_CODE", "cqut");
  }

  get dedupeKeySecret(): string {
    return this.requireSecret("DEDUPE_KEY_SECRET");
  }

  get transactionExpiresInSeconds(): number {
    return Number(this.configService.get("TRANSACTION_EXPIRES_IN_SECONDS", 600));
  }

  get authProvider(): string {
    return this.configService.get("AUTH_PROVIDER", "mock");
  }

  get verifyRateLimitEnabled(): boolean {
    return this.configService.get("VERIFY_RATE_LIMIT_ENABLED", "true").toLowerCase() !== "false";
  }

  get verifyRateLimitMax(): number {
    return Number(this.configService.get("VERIFY_RATE_LIMIT_MAX", 10));
  }

  get verifyRateLimitWindowSeconds(): number {
    return Number(this.configService.get("VERIFY_RATE_LIMIT_WINDOW_SECONDS", 60));
  }

  get jobPayloadSecret(): string {
    return this.requireSecret("JOB_PAYLOAD_SECRET");
  }

  get workerConcurrency(): number {
    return Number(this.configService.get("WORKER_CONCURRENCY", 5));
  }

  get jobMaxAttempts(): number {
    return Number(this.configService.get("JOB_MAX_ATTEMPTS", 3));
  }

  get jobRetryBaseMs(): number {
    return Number(this.configService.get("JOB_RETRY_BASE_MS", 1000));
  }

  get providerTimeoutMs(): number {
    return Number(this.configService.get("PROVIDER_TIMEOUT_MS", 10000));
  }

  get providerTotalTimeoutMs(): number {
    return Number(this.configService.get("PROVIDER_TOTAL_TIMEOUT_MS", 20000));
  }

  get workerHeartbeatIntervalMs(): number {
    return Number(this.configService.get("WORKER_HEARTBEAT_INTERVAL_MS", 5000));
  }

  get workerHeartbeatStaleMs(): number {
    return Number(this.configService.get("WORKER_HEARTBEAT_STALE_MS", 15000));
  }

  get demoClientId(): string {
    return this.configService.get("CLIENT_ID", "site_demo");
  }

  get demoClientSecret(): string {
    return this.requireSecret("CLIENT_SECRET");
  }

  get demoClientEnabled(): boolean {
    const explicit = this.configService.get<string>("DEMO_CLIENT_ENABLED");
    if (explicit !== undefined) {
      return explicit.toLowerCase() === "true";
    }
    return !this.isProduction;
  }

  get redisUrl(): string | undefined {
    return this.configService.get<string>("REDIS_URL");
  }

  get databaseUrl(): string | undefined {
    return this.configService.get<string>("DATABASE_URL");
  }

  get corsAllowedOrigins(): string[] {
    const raw = this.configService.get<string>("CORS_ALLOWED_ORIGINS");
    if (!raw) {
      return [];
    }
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  get trustProxyHops(): number {
    const raw = this.configService.get<string>("TRUST_PROXY_HOPS");
    if (raw === undefined || raw === "") {
      return this.isProduction ? 1 : 0;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("TRUST_PROXY_HOPS must be a non-negative integer");
    }
    return parsed;
  }

  private requireSecret(key: string) {
    const value = this.configService.get<string>(key);
    if (!value || this.isPlaceholder(value)) {
      throw new Error(`${key} is required and must not use a placeholder value`);
    }
    return value;
  }

  private isPlaceholder(value: string) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return true;
    }
    return (
      normalized.endsWith("change-me") ||
      normalized.startsWith("<") ||
      normalized.includes("set-in-deploy-env")
    );
  }
}
