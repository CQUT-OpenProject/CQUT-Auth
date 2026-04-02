import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { AppConfigService } from "../config/app-config.service.js";
import type { ClientConfig, VerificationJob, VerificationRequest } from "../common/types.js";

@Injectable()
export class PostgresService implements OnModuleInit {
  private readonly logger = new Logger(PostgresService.name);
  private readonly clients = new Map<string, ClientConfig>();
  private readonly jobs = new Map<string, VerificationJob>();
  private readonly requests = new Map<string, VerificationRequest>();
  private readonly workerHeartbeats = new Map<string, string>();
  private pool: Pool | undefined;

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  async onModuleInit() {
    if (!this.config.databaseUrl) {
      if (this.config.databaseRequired) {
        throw new Error("DATABASE_URL is required for the current worker mode");
      }
      return;
    }

    try {
      this.pool = new Pool({ connectionString: this.config.databaseUrl });
      await this.pool.query("select 1");
      await this.ensureSchema();
    } catch (error) {
      if (this.config.databaseRequired) {
        throw error;
      }
      this.logger.warn(
        `DATABASE_URL is configured but unavailable, falling back to in-memory persistence: ${error instanceof Error ? error.message : "unknown error"}`
      );
      await this.pool?.end().catch(() => undefined);
      this.pool = undefined;
    }
  }

  private async ensureSchema() {
    if (!this.pool) {
      return;
    }
    await this.pool.query(`
      create table if not exists clients (
        client_id text primary key,
        client_secret_hash text not null,
        allowed_scopes jsonb not null,
        status text not null,
        created_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      create table if not exists verification_requests (
        request_id text primary key,
        client_id text not null,
        scope jsonb not null,
        status text not null,
        verified boolean,
        student_status text,
        school text,
        dedupe_key text,
        internal_identity_hash text,
        error text,
        error_description text,
        created_at timestamptz not null,
        started_at timestamptz,
        completed_at timestamptz,
        expires_at timestamptz not null
      );
    `);
    await this.pool.query(`
      create index if not exists idx_verification_requests_client_created_at
      on verification_requests (client_id, created_at desc);
    `);
    await this.pool.query(`
      create index if not exists idx_verification_requests_expires_at
      on verification_requests (expires_at);
    `);
    await this.pool.query(`
      create table if not exists verification_jobs (
        job_id text primary key,
        request_id text not null unique,
        client_id text not null,
        provider text not null,
        payload_ciphertext text,
        status text not null,
        attempt_count integer not null default 0,
        available_at timestamptz not null,
        created_at timestamptz not null,
        started_at timestamptz,
        completed_at timestamptz,
        last_error text
      );
    `);
    await this.pool.query(`
      create index if not exists idx_verification_jobs_status_available_at
      on verification_jobs (status, available_at);
    `);
    await this.pool.query(`
      create table if not exists worker_heartbeats (
        worker_id text primary key,
        started_at timestamptz not null,
        last_seen_at timestamptz not null
      );
    `);
  }

  async upsertClient(client: ClientConfig) {
    this.clients.set(client.clientId, client);
    if (!this.pool) {
      return;
    }
    await this.pool.query(
      `
      insert into clients (client_id, client_secret_hash, allowed_scopes, status, created_at)
      values ($1, $2, $3::jsonb, $4, $5::timestamptz)
      on conflict (client_id) do update
      set client_secret_hash = excluded.client_secret_hash,
          allowed_scopes = excluded.allowed_scopes,
          status = excluded.status;
      `,
      [
        client.clientId,
        client.clientSecretHash,
        JSON.stringify(client.allowedScopes),
        client.status,
        client.createdAt
      ]
    );
  }

  async findClient(clientId: string): Promise<ClientConfig | null> {
    if (this.pool) {
      const result = await this.pool.query("select * from clients where client_id = $1 limit 1", [clientId]);
      if (result.rowCount) {
        const row = result.rows[0];
        return {
          clientId: row.client_id,
          clientSecretHash: row.client_secret_hash,
          allowedScopes: row.allowed_scopes,
          status: row.status,
          createdAt: row.created_at.toISOString()
        };
      }
    }
    return this.clients.get(clientId) ?? null;
  }

  async createVerificationRequestWithJob(requestRecord: VerificationRequest, jobRecord: VerificationJob) {
    this.requests.set(requestRecord.requestId, requestRecord);
    this.jobs.set(jobRecord.jobId, jobRecord);
    if (!this.pool) {
      return;
    }

    await this.withTransaction(async (client) => {
      await this.insertVerificationRequest(client, requestRecord);
      await this.insertVerificationJob(client, jobRecord);
    });
  }

  async saveVerificationRequest(requestRecord: VerificationRequest) {
    this.requests.set(requestRecord.requestId, requestRecord);
    if (!this.pool) {
      return;
    }
    await this.insertVerificationRequest(this.pool, requestRecord);
  }

  async getVerificationRequest(requestId: string): Promise<VerificationRequest | null> {
    if (this.pool) {
      const result = await this.pool.query(
        "select * from verification_requests where request_id = $1 limit 1",
        [requestId]
      );
      if (result.rowCount) {
        return mapRequestRow(result.rows[0]);
      }
    }
    return this.requests.get(requestId) ?? null;
  }

  async claimNextVerificationJob(now: string): Promise<VerificationJob | null> {
    if (!this.pool) {
      const job = [...this.jobs.values()]
        .filter((candidate) => candidate.status === "queued" && candidate.availableAt <= now)
        .sort((left, right) =>
          left.availableAt === right.availableAt
            ? left.createdAt.localeCompare(right.createdAt)
            : left.availableAt.localeCompare(right.availableAt)
        )[0];
      if (!job) {
        return null;
      }
      const request = this.requests.get(job.requestId);
      const runningJob: VerificationJob = {
        ...job,
        status: "running",
        attemptCount: job.attemptCount + 1,
        startedAt: now
      };
      this.jobs.set(job.jobId, runningJob);
      if (request) {
        this.requests.set(request.requestId, {
          ...request,
          status: "running",
          startedAt: request.startedAt ?? now
        });
      }
      return runningJob;
    }

    return this.withTransaction(async (client) => {
      const claimed = await client.query(
        `
        with next_job as (
          select job_id
          from verification_jobs
          where status = 'queued' and available_at <= $1::timestamptz
          order by available_at asc, created_at asc
          for update skip locked
          limit 1
        )
        update verification_jobs as jobs
        set status = 'running',
            attempt_count = jobs.attempt_count + 1,
            started_at = $1::timestamptz
        from next_job
        where jobs.job_id = next_job.job_id
        returning jobs.*;
        `,
        [now]
      );
      if (!claimed.rowCount) {
        return null;
      }
      const job = mapJobRow(claimed.rows[0]);
      await client.query(
        `
        update verification_requests
        set status = 'running',
            started_at = coalesce(started_at, $2::timestamptz)
        where request_id = $1
        `,
        [job.requestId, now]
      );
      return job;
    });
  }

  async completeVerificationJob(jobId: string, requestRecord: VerificationRequest, lastError?: string) {
    this.requests.set(requestRecord.requestId, requestRecord);
    const current = this.jobs.get(jobId);
    if (current) {
      this.jobs.set(jobId, {
        ...current,
        status: requestRecord.status === "succeeded" ? "succeeded" : "failed",
        payloadCiphertext: undefined,
        completedAt: requestRecord.completedAt,
        lastError
      });
    }

    if (!this.pool) {
      return;
    }

    await this.withTransaction(async (client) => {
      await this.insertVerificationRequest(client, requestRecord);
      await client.query(
        `
        update verification_jobs
        set status = $2,
            payload_ciphertext = null,
            completed_at = $3::timestamptz,
            last_error = $4
        where job_id = $1
        `,
        [jobId, requestRecord.status === "succeeded" ? "succeeded" : "failed", requestRecord.completedAt, lastError ?? null]
      );
    });
  }

  async retryVerificationJob(jobId: string, requestId: string, availableAt: string, lastError: string) {
    const job = this.jobs.get(jobId);
    if (job) {
      this.jobs.set(jobId, {
        ...job,
        status: "queued",
        availableAt,
        startedAt: undefined,
        lastError
      });
    }
    const request = this.requests.get(requestId);
    if (request) {
      this.requests.set(requestId, {
        ...request,
        status: "pending",
        error: undefined,
        errorDescription: undefined,
        completedAt: undefined
      });
    }

    if (!this.pool) {
      return;
    }

    await this.withTransaction(async (client) => {
      await client.query(
        `
        update verification_jobs
        set status = 'queued',
            available_at = $2::timestamptz,
            started_at = null,
            last_error = $3
        where job_id = $1
        `,
        [jobId, availableAt, lastError]
      );
      await client.query(
        `
        update verification_requests
        set status = 'pending',
            error = null,
            error_description = null,
            completed_at = null
        where request_id = $1
        `,
        [requestId]
      );
    });
  }

  async failVerificationJob(jobId: string, requestId: string, lastError: string) {
    const job = this.jobs.get(jobId);
    if (job) {
      this.jobs.set(jobId, {
        ...job,
        status: "failed",
        payloadCiphertext: undefined,
        completedAt: new Date().toISOString(),
        lastError
      });
    }
    this.requests.delete(requestId);

    if (!this.pool) {
      return;
    }

    await this.pool.query(
      `
      update verification_jobs
      set status = 'failed',
          payload_ciphertext = null,
          completed_at = now(),
          last_error = $2
      where job_id = $1
      `,
      [jobId, lastError]
    );
  }

  async requeueStalledJobs(staleBefore: string, availableAt: string) {
    if (!this.pool) {
      let count = 0;
      for (const [jobId, job] of this.jobs.entries()) {
        if (job.status === "running" && job.startedAt && job.startedAt < staleBefore) {
          this.jobs.set(jobId, {
            ...job,
            status: "queued",
            availableAt,
            startedAt: undefined,
            lastError: "stalled_job_requeued"
          });
          const request = this.requests.get(job.requestId);
          if (request) {
            this.requests.set(job.requestId, {
              ...request,
              status: "pending"
            });
          }
          count += 1;
        }
      }
      return count;
    }

    return this.withTransaction(async (client) => {
      const result = await client.query(
        `
        update verification_jobs
        set status = 'queued',
            available_at = $2::timestamptz,
            started_at = null,
            last_error = 'stalled_job_requeued'
        where status = 'running' and started_at < $1::timestamptz
        returning request_id
        `,
        [staleBefore, availableAt]
      );
      if (result.rowCount) {
        const requestIds = result.rows.map((row) => row.request_id as string);
        await client.query(
          `
          update verification_requests
          set status = 'pending'
          where request_id = any($1::text[]) and status = 'running'
          `,
          [requestIds]
        );
      }
      return result.rowCount ?? 0;
    });
  }

  async countQueuedVerificationJobs() {
    if (!this.pool) {
      return [...this.jobs.values()].filter((job) => job.status === "queued").length;
    }
    const result = await this.pool.query(
      "select count(*)::integer as count from verification_jobs where status = 'queued'"
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async recordWorkerHeartbeat(workerId: string, startedAt: string, lastSeenAt: string) {
    this.workerHeartbeats.set(workerId, lastSeenAt);
    if (!this.pool) {
      return;
    }
    await this.pool.query(
      `
      insert into worker_heartbeats (worker_id, started_at, last_seen_at)
      values ($1, $2::timestamptz, $3::timestamptz)
      on conflict (worker_id) do update
      set last_seen_at = excluded.last_seen_at;
      `,
      [workerId, startedAt, lastSeenAt]
    );
  }

  async hasFreshWorkerHeartbeat(staleAfter: string) {
    if (this.pool) {
      const result = await this.pool.query(
        `
        select 1
        from worker_heartbeats
        where last_seen_at >= $1::timestamptz
        limit 1
        `,
        [staleAfter]
      );
      return (result.rowCount ?? 0) > 0;
    }

    for (const lastSeenAt of this.workerHeartbeats.values()) {
      if (lastSeenAt >= staleAfter) {
        return true;
      }
    }
    return false;
  }

  hasDatabase() {
    return !!this.pool;
  }

  async checkReadiness() {
    if (!this.pool) {
      return false;
    }
    try {
      await this.pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  logFallback() {
    if (!this.pool && !this.config.databaseRequired) {
      this.logger.warn("DATABASE_URL not configured, falling back to in-memory persistence");
    }
  }

  private async withTransaction<T>(run: (client: PoolClient) => Promise<T>) {
    if (!this.pool) {
      throw new Error("database is not configured");
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await run(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertVerificationRequest(client: Pool | PoolClient, requestRecord: VerificationRequest) {
    await client.query(
      `
      insert into verification_requests
      (request_id, client_id, scope, status, verified, student_status, school, dedupe_key, internal_identity_hash, error, error_description, created_at, started_at, completed_at, expires_at)
      values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14::timestamptz, $15::timestamptz)
      on conflict (request_id) do update
      set status = excluded.status,
          verified = excluded.verified,
          student_status = excluded.student_status,
          school = excluded.school,
          dedupe_key = excluded.dedupe_key,
          internal_identity_hash = excluded.internal_identity_hash,
          error = excluded.error,
          error_description = excluded.error_description,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          expires_at = excluded.expires_at
      `,
      [
        requestRecord.requestId,
        requestRecord.clientId,
        JSON.stringify(requestRecord.scope),
        requestRecord.status,
        requestRecord.verified ?? null,
        requestRecord.studentStatus ?? null,
        requestRecord.school ?? null,
        requestRecord.dedupeKey ?? null,
        requestRecord.internalIdentityHash ?? null,
        requestRecord.error ?? null,
        requestRecord.errorDescription ?? null,
        requestRecord.createdAt,
        requestRecord.startedAt ?? null,
        requestRecord.completedAt ?? null,
        requestRecord.expiresAt
      ]
    );
  }

  private async insertVerificationJob(client: Pool | PoolClient, jobRecord: VerificationJob) {
    await client.query(
      `
      insert into verification_jobs
      (job_id, request_id, client_id, provider, payload_ciphertext, status, attempt_count, available_at, created_at, started_at, completed_at, last_error)
      values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12)
      on conflict (job_id) do update
      set status = excluded.status,
          payload_ciphertext = excluded.payload_ciphertext,
          attempt_count = excluded.attempt_count,
          available_at = excluded.available_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          last_error = excluded.last_error
      `,
      [
        jobRecord.jobId,
        jobRecord.requestId,
        jobRecord.clientId,
        jobRecord.provider,
        jobRecord.payloadCiphertext ?? null,
        jobRecord.status,
        jobRecord.attemptCount,
        jobRecord.availableAt,
        jobRecord.createdAt,
        jobRecord.startedAt ?? null,
        jobRecord.completedAt ?? null,
        jobRecord.lastError ?? null
      ]
    );
  }
}

function mapRequestRow(row: Record<string, unknown>): VerificationRequest {
  return {
    requestId: String(row["request_id"]),
    clientId: String(row["client_id"]),
    scope: row["scope"] as VerificationRequest["scope"],
    status: row["status"] as VerificationRequest["status"],
    verified: (row["verified"] as boolean | null) ?? undefined,
    studentStatus: (row["student_status"] as VerificationRequest["studentStatus"]) ?? undefined,
    school: (row["school"] as string | null) ?? undefined,
    dedupeKey: (row["dedupe_key"] as string | null) ?? undefined,
    internalIdentityHash: (row["internal_identity_hash"] as string | null) ?? undefined,
    error: (row["error"] as string | null) ?? undefined,
    errorDescription: (row["error_description"] as string | null) ?? undefined,
    createdAt: (row["created_at"] as Date).toISOString(),
    startedAt: row["started_at"] ? (row["started_at"] as Date).toISOString() : undefined,
    completedAt: row["completed_at"] ? (row["completed_at"] as Date).toISOString() : undefined,
    expiresAt: (row["expires_at"] as Date).toISOString()
  };
}

function mapJobRow(row: Record<string, unknown>): VerificationJob {
  return {
    jobId: String(row["job_id"]),
    requestId: String(row["request_id"]),
    clientId: String(row["client_id"]),
    provider: String(row["provider"]),
    payloadCiphertext: (row["payload_ciphertext"] as string | null) ?? undefined,
    status: row["status"] as VerificationJob["status"],
    attemptCount: Number(row["attempt_count"]),
    availableAt: (row["available_at"] as Date).toISOString(),
    createdAt: (row["created_at"] as Date).toISOString(),
    startedAt: row["started_at"] ? (row["started_at"] as Date).toISOString() : undefined,
    completedAt: row["completed_at"] ? (row["completed_at"] as Date).toISOString() : undefined,
    lastError: (row["last_error"] as string | null) ?? undefined
  };
}
