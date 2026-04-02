import { DEDUPE_SCOPE, SUPPORTED_SCOPES, type SupportedScope } from "@cqut/shared";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError, RateLimitError } from "../common/api-error.js";
import { JobPayloadCryptoService } from "../common/job-payload-crypto.service.js";
import { MetricsService } from "../common/metrics.service.js";
import type { ClientConfig, VerificationJob, VerificationRequest } from "../common/types.js";
import { randomId } from "../common/utils.js";
import { AppConfigService } from "../config/app-config.service.js";
import { PostgresService } from "../persistence/postgres.service.js";
import { RedisService } from "../persistence/redis.service.js";
import { VerifyRateLimitService } from "./verify-rate-limit.service.js";

type VerifyInput = {
  client: ClientConfig;
  account: string;
  password: string;
  scope: string[];
};

@Injectable()
export class AuthService {
  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PostgresService) private readonly postgres: PostgresService,
    @Inject(VerifyRateLimitService) private readonly verifyRateLimit: VerifyRateLimitService,
    @Inject(JobPayloadCryptoService) private readonly crypto: JobPayloadCryptoService,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {}

  async submitVerify(input: VerifyInput) {
    const rateLimitDecision = await this.verifyRateLimit.consume(input.client.clientId);
    if (!rateLimitDecision.allowed) {
      throw new RateLimitError(rateLimitDecision.retryAfterSeconds);
    }

    if (!input.account || !input.password) {
      throw new ApiError("invalid_request", "missing account or password");
    }

    const normalizedScope = input.scope.length ? input.scope : ["student.verify"];
    if (normalizedScope.some((value) => !SUPPORTED_SCOPES.includes(value as SupportedScope))) {
      throw new ApiError("invalid_scope", "requested scope is not allowed");
    }
    const allowed = new Set(input.client.allowedScopes);
    if (normalizedScope.some((value) => !allowed.has(value as SupportedScope))) {
      throw new ApiError("invalid_scope", "requested scope is not allowed for client");
    }

    const now = new Date().toISOString();
    const requestRecord: VerificationRequest = {
      requestId: randomId("req"),
      clientId: input.client.clientId,
      scope: normalizedScope as SupportedScope[],
      status: "pending",
      createdAt: now,
      expiresAt: new Date(Date.now() + this.config.transactionExpiresInSeconds * 1000).toISOString()
    };

    const jobRecord: VerificationJob = {
      jobId: randomId("job"),
      requestId: requestRecord.requestId,
      clientId: requestRecord.clientId,
      provider: this.config.authProvider,
      payloadCiphertext: this.crypto.encrypt({
        account: input.account,
        password: input.password
      }),
      status: "queued",
      attemptCount: 0,
      availableAt: now,
      createdAt: now
    };

    await this.postgres.createVerificationRequestWithJob(requestRecord, jobRecord);
    await this.redis.saveVerificationRequest(requestRecord, this.config.transactionExpiresInSeconds);
    this.metrics.recordVerifyAccepted();
    this.metrics.setQueueBacklog(await this.postgres.countQueuedVerificationJobs());

    return {
      request_id: requestRecord.requestId,
      status: requestRecord.status,
      expires_at: requestRecord.expiresAt
    };
  }

  async getResult(requestId: string, clientId: string) {
    const cached = await this.redis.getVerificationRequest(requestId);
    if (cached) {
      this.metrics.recordCacheHit();
      return this.toResultPayload(cached, clientId);
    }

    this.metrics.recordCacheMiss();
    const requestRecord = await this.postgres.getVerificationRequest(requestId);
    if (!requestRecord || requestRecord.clientId !== clientId) {
      throw new ApiError("invalid_request", "verification request not found");
    }
    if (requestRecord.status === "succeeded" || requestRecord.status === "failed") {
      await this.redis.saveVerificationRequest(requestRecord, this.config.transactionExpiresInSeconds);
    }
    return this.toResultPayload(requestRecord, clientId);
  }

  private toResultPayload(requestRecord: VerificationRequest, clientId: string) {
    if (requestRecord.clientId !== clientId) {
      throw new ApiError("invalid_request", "verification request not found");
    }
    if (new Date(requestRecord.expiresAt).getTime() < Date.now()) {
      throw new ApiError("invalid_request", "verification request expired");
    }

    if (requestRecord.status === "pending" || requestRecord.status === "running") {
      return {
        request_id: requestRecord.requestId,
        status: requestRecord.status,
        expires_at: requestRecord.expiresAt
      };
    }

    if (requestRecord.status === "failed") {
      return {
        request_id: requestRecord.requestId,
        status: requestRecord.status,
        error: requestRecord.error ?? "verification_failed",
        error_description: requestRecord.errorDescription ?? "verification failed",
        completed_at: requestRecord.completedAt
      };
    }

    return {
      request_id: requestRecord.requestId,
      status: requestRecord.status,
      verified: requestRecord.verified,
      student_status: requestRecord.studentStatus,
      school: requestRecord.school,
      dedupe_key: requestRecord.dedupeKey,
      completed_at: requestRecord.completedAt
    };
  }
}
