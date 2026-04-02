import { setTimeout as sleep } from "node:timers/promises";
import { DEDUPE_SCOPE } from "@cqut/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ApiError } from "../common/api-error.js";
import { JobPayloadCryptoService } from "../common/job-payload-crypto.service.js";
import { MetricsService } from "../common/metrics.service.js";
import type { VerificationJob, VerificationRequest } from "../common/types.js";
import { AppConfigService } from "../config/app-config.service.js";
import { PostgresService } from "../persistence/postgres.service.js";
import { RedisService } from "../persistence/redis.service.js";
import { RetryableProviderError } from "../providers/provider.errors.js";
import { ProviderRegistry } from "../providers/provider.registry.js";
import { DedupeKeyService } from "../auth/dedupe-key.service.js";

@Injectable()
export class VerificationWorkerService {
  private static readonly IDLE_POLL_BASE_MS = 100;
  private static readonly IDLE_POLL_MAX_MS = 2000;
  private readonly logger = new Logger(VerificationWorkerService.name);
  private running = true;
  private startPromise: Promise<void> | null = null;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PostgresService) private readonly postgres: PostgresService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ProviderRegistry) private readonly providerRegistry: ProviderRegistry,
    @Inject(DedupeKeyService) private readonly dedupeKeyService: DedupeKeyService,
    @Inject(JobPayloadCryptoService) private readonly crypto: JobPayloadCryptoService,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {}

  async start() {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.running = true;
    this.startPromise = (async () => {
      await this.requeueStalledJobs();
      await this.refreshQueueBacklog();
      const workers = Array.from({ length: this.config.workerConcurrency }, (_, index) =>
        this.runLoop(index + 1)
      );
      await Promise.all(workers);
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  startInBackground() {
    if (this.startPromise) {
      return;
    }

    void this.start().catch((error: unknown) => {
      this.logger.error(
        JSON.stringify({
          event: "worker_start_failed",
          error: error instanceof Error ? error.message : "unknown error"
        })
      );
    });
  }

  stop() {
    this.running = false;
  }

  async waitForStop() {
    await this.startPromise;
  }

  async runOnce() {
    const job = await this.postgres.claimNextVerificationJob(new Date().toISOString());
    if (!job) {
      return false;
    }

    await this.refreshQueueBacklog();
    await this.processJob(job);
    await this.refreshQueueBacklog();
    return true;
  }

  private async runLoop(workerIndex: number) {
    let idleAttempts = 0;

    while (this.running) {
      try {
        const found = await this.runOnce();
        if (!found) {
          idleAttempts += 1;
          await sleep(this.getIdleDelayMs(idleAttempts));
          continue;
        }

        idleAttempts = 0;
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: "worker_loop_error",
            worker_index: workerIndex,
            error: error instanceof Error ? error.message : "unknown error"
          })
        );
        await sleep(1000);
      }
    }
  }

  private async processJob(job: VerificationJob) {
    const requestRecord = await this.postgres.getVerificationRequest(job.requestId);
    if (!requestRecord) {
      await this.postgres.failVerificationJob(job.jobId, job.requestId, "request_not_found");
      this.metrics.recordWorkerFailure();
      return;
    }

    if (!job.payloadCiphertext) {
      await this.finalizeFailure(job, requestRecord, new ApiError("verification_failed", "job payload missing"));
      return;
    }

    if (new Date(requestRecord.expiresAt).getTime() < Date.now()) {
      await this.finalizeFailure(job, requestRecord, new ApiError("verification_failed", "verification request expired"));
      return;
    }

    const payload = this.crypto.decrypt(job.payloadCiphertext);
    const provider = this.providerRegistry.getByName(job.provider);
    const started = Date.now();

    try {
      const identity = await provider.verifyCredentials(payload);
      const completedAt = new Date().toISOString();
      const dedupeKey =
        identity.verified && requestRecord.scope.includes(DEDUPE_SCOPE)
          ? this.dedupeKeyService.derive(requestRecord.clientId, identity.schoolUid)
          : undefined;

      const succeededRequest: VerificationRequest = {
        ...requestRecord,
        status: "succeeded",
        verified: identity.verified,
        studentStatus: identity.studentStatus,
        school: identity.school,
        completedAt,
        ...(dedupeKey !== undefined ? { dedupeKey } : {}),
        ...(identity.identityHash !== undefined
          ? { internalIdentityHash: identity.identityHash }
          : {})
      };

      await this.postgres.completeVerificationJob(job.jobId, succeededRequest);
      await this.redis.saveVerificationRequest(succeededRequest, this.config.transactionExpiresInSeconds);
      this.metrics.recordWorkerSuccess();
      this.metrics.recordProviderLatency(Date.now() - started);
      this.logger.log(
        JSON.stringify({
          event: "verification_job_succeeded",
          request_id: job.requestId,
          client_id: job.clientId,
          job_id: job.jobId,
          provider: job.provider,
          status: "succeeded",
          latency_ms: Date.now() - started
        })
      );
    } catch (error) {
      this.metrics.recordProviderLatency(Date.now() - started);
      if (error instanceof RetryableProviderError && job.attemptCount < this.config.jobMaxAttempts) {
        const delayMs = this.config.jobRetryBaseMs * 2 ** Math.max(0, job.attemptCount - 1);
        const availableAt = new Date(Date.now() + delayMs).toISOString();
        await this.postgres.retryVerificationJob(job.jobId, job.requestId, availableAt, error.message);
        await this.redis.saveVerificationRequest(
          {
            ...requestRecord,
            status: "pending"
          },
          this.config.transactionExpiresInSeconds
        );
        this.metrics.recordWorkerRetry();
        this.logger.warn(
          JSON.stringify({
            event: "verification_job_retry",
            request_id: job.requestId,
            client_id: job.clientId,
            job_id: job.jobId,
            provider: job.provider,
            status: "queued",
            latency_ms: Date.now() - started,
            attempt_count: job.attemptCount,
            available_at: availableAt
          })
        );
        return;
      }

      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(
              "verification_failed",
              error instanceof Error ? error.message : "verification failed"
            );
      await this.finalizeFailure(job, requestRecord, apiError, Date.now() - started);
    }
  }

  private async finalizeFailure(
    job: VerificationJob,
    requestRecord: VerificationRequest,
    apiError: ApiError,
    latencyMs = 0
  ) {
    const failedRequest: VerificationRequest = {
      ...requestRecord,
      status: "failed",
      error: String(apiError.code),
      errorDescription: apiError.description,
      completedAt: new Date().toISOString()
    };
    await this.postgres.completeVerificationJob(job.jobId, failedRequest, apiError.description);
    await this.redis.saveVerificationRequest(failedRequest, this.config.transactionExpiresInSeconds);
    this.metrics.recordWorkerFailure();
    this.logger.warn(
      JSON.stringify({
        event: "verification_job_failed",
        request_id: job.requestId,
        client_id: job.clientId,
        job_id: job.jobId,
        provider: job.provider,
        status: "failed",
        latency_ms: latencyMs,
        error: apiError.code
      })
    );
  }

  private async requeueStalledJobs() {
    const staleBefore = new Date(Date.now() - this.config.providerTotalTimeoutMs).toISOString();
    const requeued = await this.postgres.requeueStalledJobs(staleBefore, new Date().toISOString());
    if (requeued > 0) {
      this.logger.warn(
        JSON.stringify({
          event: "verification_jobs_requeued",
          count: requeued
        })
      );
    }
  }

  private async refreshQueueBacklog() {
    this.metrics.setQueueBacklog(await this.postgres.countQueuedVerificationJobs());
  }

  private getIdleDelayMs(idleAttempts: number) {
    return Math.min(
      VerificationWorkerService.IDLE_POLL_MAX_MS,
      VerificationWorkerService.IDLE_POLL_BASE_MS * 2 ** Math.max(0, idleAttempts - 1)
    );
  }
}
