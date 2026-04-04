import type { Pool } from "pg";

export class ArtifactCleanupConfigurationError extends Error {}

export type ArtifactCleanupOptions = {
  enabled: boolean;
  schedule: string;
  jobName?: string;
};

type CleanupJob = {
  jobid: number;
  schedule: string;
  command: string;
};

export async function ensureArtifactCleanupJob(pool: Pool, options: ArtifactCleanupOptions) {
  if (!options.enabled) {
    throw new ArtifactCleanupConfigurationError("OIDC_ARTIFACT_CLEANUP_ENABLED must be true");
  }
  const jobName = options.jobName ?? "oidc_artifacts_expired_cleanup";
  const command = "delete from oidc_artifacts where expires_at is not null and expires_at <= now()";
  const normalizedCommand = normalizeSql(command);

  try {
    await pool.query("create extension if not exists pg_cron");
  } catch (error) {
    throw new ArtifactCleanupConfigurationError(
      `failed to create pg_cron extension: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  const extension = await pool.query(
    "select extname from pg_extension where extname = 'pg_cron' limit 1"
  );
  if (extension.rowCount !== 1) {
    throw new ArtifactCleanupConfigurationError("pg_cron extension is required but unavailable");
  }

  const existing = await pool.query(
    "select jobid, schedule, command from cron.job where jobname = $1 limit 1",
    [jobName]
  );
  const current = existing.rows[0] as CleanupJob | undefined;
  if (current && current.schedule === options.schedule && normalizeSql(current.command) === normalizedCommand) {
    return;
  }

  if (current) {
    await pool.query("select cron.unschedule($1::bigint)", [current.jobid]);
  }
  await pool.query("select cron.schedule($1, $2, $3)", [jobName, options.schedule, command]);
}

function normalizeSql(raw: string) {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}
