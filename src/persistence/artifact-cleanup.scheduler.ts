import type { Pool } from "pg";
import { buildArtifactCleanupSql } from "./contracts.js";

export class ArtifactCleanupConfigurationError extends Error {}

export type ArtifactCleanupOptions = {
  schedule: string;
  batchSize: number;
  jobName?: string;
};

type CleanupJob = {
  jobid: number;
  schedule: string;
  command: string;
};

export async function ensureArtifactCleanupJob(
  pool: Pool,
  options: ArtifactCleanupOptions,
) {
  const jobName = options.jobName ?? "oidc_artifacts_expired_cleanup";
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
    throw new ArtifactCleanupConfigurationError(
      "OIDC_ARTIFACT_CLEANUP_BATCH_SIZE must be a positive integer",
    );
  }
  const command = buildArtifactCleanupSql(options.batchSize);
  const normalizedCommand = normalizeSql(command);

  try {
    await pool.query("create extension if not exists pg_cron");
  } catch (error) {
    console.warn(
      `pg_cron unavailable (${error instanceof Error ? error.message : "unknown error"}); ` +
        "skipping scheduled artifact cleanup, opportunistic cleanup remains active",
    );
    return;
  }

  const extension = await pool.query(
    "select extname from pg_extension where extname = 'pg_cron' limit 1",
  );
  if (extension.rowCount !== 1) {
    console.warn(
      "pg_cron extension is unavailable; " +
        "skipping scheduled artifact cleanup, opportunistic cleanup remains active",
    );
    return;
  }

  const existing = await pool.query(
    "select jobid, schedule, command from cron.job where jobname = $1 limit 1",
    [jobName],
  );
  const current = existing.rows[0] as CleanupJob | undefined;
  if (
    current &&
    current.schedule === options.schedule &&
    normalizeSql(current.command) === normalizedCommand
  ) {
    return;
  }

  if (current) {
    await pool.query("select cron.unschedule($1::bigint)", [current.jobid]);
  }
  await pool.query("select cron.schedule($1, $2, $3)", [
    jobName,
    options.schedule,
    command,
  ]);
}

function normalizeSql(raw: string) {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}
