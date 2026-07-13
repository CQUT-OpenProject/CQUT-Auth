import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import {
  ClientManagementError,
  ClientManagementService,
} from "../src/clients/client-management.service.js";
import type { OidcClientAuditRecord } from "../src/persistence/contracts.js";
import { OidcClientRepositoryImpl } from "../src/persistence/oidc-client.repository.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const owner = { subjectId: "subj_pg_owner", isAdmin: false };
const admin = { subjectId: "subj_pg_admin", isAdmin: true };
const input = {
  clientType: "spa" as const,
  displayName: "PostgreSQL Client",
  description: "",
  redirectUris: ["http://localhost:3002/callback"],
  postLogoutRedirectUris: ["http://localhost:3002/logout"],
  scopeWhitelist: ["openid", "profile"],
};
const webInput = { ...input, clientType: "web" as const };

test(
  "PostgreSQL enforces client revision transactions and concurrency",
  { skip: !databaseUrl },
  async (context) => {
    const pool = new Pool({ connectionString: databaseUrl });
    const schemaWithScheduler = await readFile(
      new URL("../scripts/init-db.sql", import.meta.url),
      "utf8",
    );
    const schema = schemaWithScheduler.split(
      "create extension if not exists pg_cron;",
    )[0]!;
    let sequence = 0;

    async function reset(maxPendingClientsPerOwner = 5) {
      await pool.query("drop schema public cascade; create schema public");
      await pool.query(schema);
      await pool.query(`insert into subjects (subject_id) values ($1), ($2)`, [
        owner.subjectId,
        admin.subjectId,
      ]);
      const repository = new OidcClientRepositoryImpl(() => pool);
      const service = new ClientManagementService(repository, "test", {
        createClientId: () => `pg_client_${++sequence}`,
        maxClientsPerOwner: 20,
        maxPendingClientsPerOwner,
        adminQuotaExempt: false,
      });
      return { repository, service };
    }

    async function createActive(service: ClientManagementService) {
      const created = await service.create(owner, input);
      const draft = created.client.proposedRevision!;
      const pending = await service.submit(owner, created.client.clientId, {
        revisionId: draft.revisionId,
        revisionVersion: draft.version,
      });
      return service.approve(admin, created.client.clientId, {
        revisionId: pending.proposedRevision!.revisionId,
        revisionVersion: pending.proposedRevision!.version,
      });
    }

    try {
      await context.test(
        "initializes the fresh schema and partial index",
        async () => {
          await reset();
          const index = await pool.query(
            `select indexdef from pg_indexes
           where schemaname = 'public' and indexname = 'uq_oidc_client_revisions_open'`,
          );
          assert.equal(index.rowCount, 1);
          assert.match(String(index.rows[0]?.["indexdef"]), /draft.*pending/);
        },
      );

      await context.test(
        "serializes open revision creation and concurrent approval",
        async () => {
          const { repository, service } = await reset();
          const active = await createActive(service);
          const attempts = await Promise.allSettled([
            service.saveRevision(owner, active.clientId, {
              redirectUris: ["http://localhost:3002/first"],
            }),
            service.saveRevision(owner, active.clientId, {
              redirectUris: ["http://localhost:3002/second"],
            }),
          ]);
          assert.equal(
            attempts.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const pending = (await repository.findManagedOidcClient(
            active.clientId,
          ))!.proposedRevision!;
          const approvals = await Promise.allSettled([
            service.approve(admin, active.clientId, {
              revisionId: pending.revisionId,
              revisionVersion: pending.version,
            }),
            service.approve(admin, active.clientId, {
              revisionId: pending.revisionId,
              revisionVersion: pending.version,
            }),
          ]);
          assert.equal(
            approvals.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const current = await repository.findManagedOidcClient(
            active.clientId,
          );
          assert.equal(current?.activeRevision?.revisionNumber, 2);
          assert.equal(current?.proposedRevision, null);
        },
      );

      await context.test(
        "keeps approval and disable atomic when racing",
        async () => {
          const { repository, service } = await reset();
          const active = await createActive(service);
          const pending = await service.saveRevision(owner, active.clientId, {
            redirectUris: ["http://localhost:3002/race"],
          });
          const results = await Promise.allSettled([
            service.approve(admin, active.clientId, {
              revisionId: pending.proposedRevision!.revisionId,
              revisionVersion: pending.proposedRevision!.version,
            }),
            service.disable(owner, active.clientId, {
              clientVersion: pending.clientVersion,
            }),
          ]);
          assert.equal(
            results.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const current = await repository.findManagedOidcClient(
            active.clientId,
          );
          assert.equal(current?.proposedRevision, null);
          const revision = await pool.query(
            "select review_status from oidc_client_revisions where client_id = $1 and revision_number = 2",
            [active.clientId],
          );
          assert.ok(
            revision.rows[0]?.["review_status"] === "approved" ||
              revision.rows[0]?.["review_status"] === "cancelled",
          );
        },
      );

      await context.test(
        "serializes secret rotation and isolates client authorization revocation",
        async () => {
          const { repository, service } = await reset();
          const created = await service.create(owner, webInput);
          const attempts = await Promise.allSettled([
            service.rotateSecret(owner, created.client.clientId, {
              clientVersion: created.client.clientVersion,
              gracePeriodSeconds: 60,
            }),
            service.rotateSecret(owner, created.client.clientId, {
              clientVersion: created.client.clientVersion,
              gracePeriodSeconds: 60,
            }),
          ]);
          assert.equal(
            attempts.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const current = await service.get(owner, created.client.clientId);
          assert.equal(
            current.secrets.filter((secret) => secret.status !== "revoked")
              .length,
            2,
          );
          const retiring = current.secrets.find(
            (secret) => secret.status === "retiring",
          )!;
          const afterSecretRevoke = await service.revokeSecret(
            owner,
            created.client.clientId,
            retiring.secretId,
            {
              clientVersion: current.clientVersion,
              secretVersion: retiring.version,
            },
          );
          await pool.query(
            `insert into oidc_artifacts (id, kind, client_id_hash, payload, created_at)
             values ('Grant:owned', 'Grant', $1, '{}'::jsonb, now()),
                    ('Grant:other', 'Grant', 'other-client', '{}'::jsonb, now()),
                    ('Session:owned', 'Session', $1, '{}'::jsonb, now())`,
            [created.client.clientId],
          );
          const revoked = await service.revokeAuthorizations(
            owner,
            created.client.clientId,
            { clientVersion: afterSecretRevoke.clientVersion },
          );
          assert.equal(
            Number(
              (
                await pool.query(
                  "select count(*)::int as count from oidc_artifacts where id = 'Grant:owned'",
                )
              ).rows[0]?.["count"],
            ),
            0,
          );
          assert.equal(
            Number(
              (
                await pool.query(
                  "select count(*)::int as count from oidc_artifacts where id in ('Grant:other', 'Session:owned')",
                )
              ).rows[0]?.["count"],
            ),
            2,
          );
          const disabled = await service.disable(
            owner,
            created.client.clientId,
            {
              clientVersion: revoked.clientVersion,
            },
          );
          assert.equal(disabled.lifecycleStatus, "disabled");
          assert.ok(
            disabled.secrets.every((secret) => secret.status === "revoked"),
          );
          assert.equal(
            await repository.findOidcClient(created.client.clientId),
            null,
          );
        },
      );

      await context.test("serializes pending quota submissions", async () => {
        const { service } = await reset(1);
        const first = await service.create(owner, input);
        const second = await service.create(owner, input);
        const results = await Promise.allSettled([
          service.submit(owner, first.client.clientId, {
            revisionId: first.client.proposedRevision!.revisionId,
            revisionVersion: first.client.proposedRevision!.version,
          }),
          service.submit(owner, second.client.clientId, {
            revisionId: second.client.proposedRevision!.revisionId,
            revisionVersion: second.client.proposedRevision!.version,
          }),
        ]);
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        const rejected = results.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult;
        assert.ok(rejected.reason instanceof ClientManagementError);
        assert.equal(rejected.reason.code, "pending_revision_quota_exceeded");
        assert.equal(
          Number(
            (
              await pool.query(
                "select count(*)::int as count from oidc_client_revisions where review_status = 'pending'",
              )
            ).rows[0]?.["count"],
          ),
          1,
        );
      });

      await context.test(
        "hides older rejected revisions after a newer approval",
        async () => {
          const { service } = await reset();
          const active = await createActive(service);
          const second = await service.saveRevision(owner, active.clientId, {
            scopeWhitelist: ["openid", "email"],
          });
          await service.reject(admin, active.clientId, {
            revisionId: second.proposedRevision!.revisionId,
            revisionVersion: second.proposedRevision!.version,
            reason: "not justified",
          });
          const thirdDraft = await service.saveRevision(
            owner,
            active.clientId,
            {
              scopeWhitelist: ["openid", "profile", "email"],
            },
          );
          const thirdPending = await service.submit(owner, active.clientId, {
            revisionId: thirdDraft.proposedRevision!.revisionId,
            revisionVersion: thirdDraft.proposedRevision!.version,
          });
          const thirdApproved = await service.approve(admin, active.clientId, {
            revisionId: thirdPending.proposedRevision!.revisionId,
            revisionVersion: thirdPending.proposedRevision!.version,
          });
          assert.equal(thirdApproved.proposedRevision, null);
          const fourth = await service.saveRevision(owner, active.clientId, {
            redirectUris: ["http://localhost:3002/fourth"],
          });
          assert.equal(fourth.proposedRevision?.revisionNumber, 4);
          assert.deepEqual(fourth.proposedRevision?.scopeWhitelist, [
            "openid",
            "profile",
            "email",
          ]);
        },
      );

      await context.test(
        "rolls back activation when audit insertion fails",
        async () => {
          const { repository, service } = await reset();
          const active = await createActive(service);
          const pending = await service.saveRevision(owner, active.clientId, {
            redirectUris: ["http://localhost:3002/rollback"],
          });
          const timestamp = new Date().toISOString();
          const invalidAudit = {
            clientId: active.clientId,
            actorSubjectId: admin.subjectId,
            action: "revision.activated",
            changedFields: [1n] as unknown as string[],
            createdAt: timestamp,
          } satisfies OidcClientAuditRecord;
          await assert.rejects(() =>
            repository.approveOidcClientRevision(
              active.clientId,
              pending.proposedRevision!.revisionId,
              pending.proposedRevision!.version,
              [invalidAudit],
            ),
          );
          const current = await repository.findManagedOidcClient(
            active.clientId,
          );
          assert.equal(current?.activeRevision?.revisionNumber, 1);
          assert.equal(current?.proposedRevision?.status, "pending");
        },
      );
    } finally {
      await pool.end();
    }
  },
);
