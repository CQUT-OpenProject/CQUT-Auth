import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  ensureArtifactCleanupJob,
  ArtifactCleanupConfigurationError
} from "../src/persistence/artifact-cleanup.scheduler.js";

type QueryResult = {
  rowCount?: number;
  rows?: Record<string, unknown>[];
};

class FakePool {
  readonly calls: Array<{ sql: string; values: unknown[] | undefined }> = [];

  constructor(private readonly responder: (sql: string, values: unknown[] | undefined) => QueryResult) {}

  async query(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    const result = this.responder(sql, values);
    return {
      rowCount: result.rowCount ?? (result.rows ? result.rows.length : 0),
      rows: result.rows ?? []
    };
  }
}

test("ensureArtifactCleanupJob creates cron job when missing", async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes("pg_extension")) {
      return { rowCount: 1, rows: [{ extname: "pg_cron" }] };
    }
    if (sql.includes("from cron.job")) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  });

  await ensureArtifactCleanupJob(pool as unknown as Pool, {
    enabled: true,
    schedule: "*/5 * * * *",
    batchSize: 5000
  });

  const scheduleCall = pool.calls.find((call) => call.sql.includes("cron.schedule"));
  assert.ok(scheduleCall);
  assert.equal(scheduleCall.values?.[0], "oidc_artifacts_expired_cleanup");
  assert.equal(scheduleCall.values?.[1], "*/5 * * * *");
  assert.match(String(scheduleCall.values?.[2]), /with doomed as/i);
  assert.match(String(scheduleCall.values?.[2]), /limit 5000/i);
});

test("ensureArtifactCleanupJob is idempotent when schedule and command match", async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes("pg_extension")) {
      return { rowCount: 1, rows: [{ extname: "pg_cron" }] };
    }
    if (sql.includes("from cron.job")) {
      return {
        rowCount: 1,
        rows: [
          {
            jobid: 7,
            schedule: "*/5 * * * *",
            command:
              "\n WITH doomed AS (\n  SELECT id\n  FROM oidc_artifacts\n  WHERE expires_at IS NOT NULL AND expires_at <= now()\n  ORDER BY expires_at ASC\n  LIMIT 5000\n )\n DELETE FROM oidc_artifacts AS oa\n USING doomed\n WHERE oa.id = doomed.id\n "
          }
        ]
      };
    }
    return { rowCount: 1, rows: [] };
  });

  await ensureArtifactCleanupJob(pool as unknown as Pool, {
    enabled: true,
    schedule: "*/5 * * * *",
    batchSize: 5000
  });

  assert.equal(pool.calls.some((call) => call.sql.includes("cron.unschedule")), false);
  assert.equal(pool.calls.some((call) => call.sql.includes("cron.schedule")), false);
});

test("ensureArtifactCleanupJob fails when pg_cron extension is unavailable", async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes("pg_extension")) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  });

  await assert.rejects(
    () =>
      ensureArtifactCleanupJob(pool as unknown as Pool, {
        enabled: true,
        schedule: "*/5 * * * *",
        batchSize: 5000
      }),
    ArtifactCleanupConfigurationError
  );
});

test("ensureArtifactCleanupJob rejects invalid batch size", async () => {
  const pool = new FakePool(() => ({ rowCount: 1, rows: [] }));

  await assert.rejects(
    () =>
      ensureArtifactCleanupJob(pool as unknown as Pool, {
        enabled: true,
        schedule: "*/5 * * * *",
        batchSize: 0
      }),
    ArtifactCleanupConfigurationError
  );
});
