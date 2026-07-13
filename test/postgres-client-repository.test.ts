import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import {
  ClientManagementError,
  ClientManagementService,
} from "../src/clients/client-management.service.js";
import type {
  OidcClientAuditRecord,
  ProjectAuditRecord,
} from "../src/persistence/contracts.js";
import { OidcClientRepositoryImpl } from "../src/persistence/oidc-client.repository.js";
import { ProjectRepositoryImpl } from "../src/persistence/project.repository.js";
import { ProjectAccessService } from "../src/projects/project-access.js";

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
const artifactSecret = "postgres-client-artifact-secret";
const clientHash = (clientId: string) =>
  createHmac("sha256", artifactSecret).update(clientId).digest("hex");
const projectId = "pg_project";

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

    async function reset(
      maxPendingClientsPerOwner = 5,
      now: () => Date = () => new Date(),
    ) {
      await pool.query("drop schema public cascade; create schema public");
      await pool.query(schema);
      await pool.query(`insert into subjects (subject_id) values ($1), ($2)`, [
        owner.subjectId,
        admin.subjectId,
      ]);
      await pool.query(
        `insert into projects (project_id, name, created_by_subject_id)
         values ($1, 'PostgreSQL project', $2)`,
        [projectId, owner.subjectId],
      );
      await pool.query(
        `insert into project_members (project_id, subject_id, role)
         values ($1, $2, 'owner')`,
        [projectId, owner.subjectId],
      );
      const repository = new OidcClientRepositoryImpl(() => pool, clientHash);
      const projects = new ProjectRepositoryImpl(
        () => pool,
        async () => true,
      );
      const service = new ClientManagementService(
        repository,
        new ProjectAccessService(projects),
        "test",
        {
          createClientId: () => `pg_client_${++sequence}`,
          maxClientsPerProject: 20,
          maxPendingClientsPerProject: maxPendingClientsPerOwner,
          adminQuotaExempt: false,
          now,
        },
      );
      return { repository, projects, service };
    }

    async function createActive(service: ClientManagementService) {
      const created = await service.create(owner, projectId, input);
      const draft = created.client.proposedRevision!;
      const pending = await service.submit(
        owner,
        projectId,
        created.client.clientId,
        {
          revisionId: draft.revisionId,
          revisionVersion: draft.version,
        },
      );
      return service.approve(admin, projectId, created.client.clientId, {
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
            service.saveRevision(owner, projectId, active.clientId, {
              redirectUris: ["http://localhost:3002/first"],
            }),
            service.saveRevision(owner, projectId, active.clientId, {
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
            service.approve(admin, projectId, active.clientId, {
              revisionId: pending.revisionId,
              revisionVersion: pending.version,
            }),
            service.approve(admin, projectId, active.clientId, {
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
          const pending = await service.saveRevision(
            owner,
            projectId,
            active.clientId,
            {
              redirectUris: ["http://localhost:3002/race"],
            },
          );
          const results = await Promise.allSettled([
            service.approve(admin, projectId, active.clientId, {
              revisionId: pending.proposedRevision!.revisionId,
              revisionVersion: pending.proposedRevision!.version,
            }),
            service.disable(owner, projectId, active.clientId, {
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
          const created = await service.create(owner, projectId, webInput);
          const attempts = await Promise.allSettled([
            service.rotateSecret(owner, projectId, created.client.clientId, {
              clientVersion: created.client.clientVersion,
              gracePeriodSeconds: 60,
            }),
            service.rotateSecret(owner, projectId, created.client.clientId, {
              clientVersion: created.client.clientVersion,
              gracePeriodSeconds: 60,
            }),
          ]);
          assert.equal(
            attempts.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const current = await service.get(
            owner,
            projectId,
            created.client.clientId,
          );
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
            projectId,
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
            [clientHash(created.client.clientId)],
          );
          const revoked = await service.revokeAuthorizations(
            owner,
            projectId,
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
            projectId,
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

      await context.test(
        "uses PostgreSQL time for rotation creation and grace expiry",
        async () => {
          const { service } = await reset(
            5,
            () => new Date("2020-01-01T00:00:00.000Z"),
          );
          const created = await service.create(owner, projectId, webInput);
          const before = Date.now();
          const rotated = await service.rotateSecret(
            owner,
            projectId,
            created.client.clientId,
            {
              clientVersion: created.client.clientVersion,
              gracePeriodSeconds: 60,
            },
          );
          const createdAt = new Date(rotated.secret.createdAt).getTime();
          assert.ok(
            createdAt >= before - 2_000 && createdAt <= Date.now() + 2_000,
          );
          const retiring = rotated.client.secrets.find(
            (secret) => secret.status === "retiring",
          );
          assert.ok(retiring?.expiresAt);
          assert.ok(
            Math.abs(
              new Date(retiring.expiresAt).getTime() - createdAt - 60_000,
            ) < 2_000,
          );
        },
      );

      await context.test("serializes pending quota submissions", async () => {
        const { service } = await reset(1);
        const first = await service.create(owner, projectId, input);
        const second = await service.create(owner, projectId, input);
        const results = await Promise.allSettled([
          service.submit(owner, projectId, first.client.clientId, {
            revisionId: first.client.proposedRevision!.revisionId,
            revisionVersion: first.client.proposedRevision!.version,
          }),
          service.submit(owner, projectId, second.client.clientId, {
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
          const second = await service.saveRevision(
            owner,
            projectId,
            active.clientId,
            {
              scopeWhitelist: ["openid", "email"],
            },
          );
          await service.reject(admin, projectId, active.clientId, {
            revisionId: second.proposedRevision!.revisionId,
            revisionVersion: second.proposedRevision!.version,
            reason: "not justified",
          });
          const thirdDraft = await service.saveRevision(
            owner,
            projectId,
            active.clientId,
            {
              scopeWhitelist: ["openid", "profile", "email"],
            },
          );
          const thirdPending = await service.submit(
            owner,
            projectId,
            active.clientId,
            {
              revisionId: thirdDraft.proposedRevision!.revisionId,
              revisionVersion: thirdDraft.proposedRevision!.version,
            },
          );
          const thirdApproved = await service.approve(
            admin,
            projectId,
            active.clientId,
            {
              revisionId: thirdPending.proposedRevision!.revisionId,
              revisionVersion: thirdPending.proposedRevision!.version,
            },
          );
          assert.equal(thirdApproved.proposedRevision, null);
          const fourth = await service.saveRevision(
            owner,
            projectId,
            active.clientId,
            {
              redirectUris: ["http://localhost:3002/fourth"],
            },
          );
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
          const pending = await service.saveRevision(
            owner,
            projectId,
            active.clientId,
            {
              redirectUris: ["http://localhost:3002/rollback"],
            },
          );
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

      await context.test(
        "serializes project member roles and preserves an owner",
        async () => {
          const { projects } = await reset();
          const now = new Date().toISOString();
          const audit = (
            action: ProjectAuditRecord["action"],
          ): ProjectAuditRecord => ({
            projectId,
            actorSubjectId: owner.subjectId,
            action,
            changedFields: ["role"],
            createdAt: now,
          });
          const added = await projects.addProjectMember(
            {
              projectId,
              subjectId: admin.subjectId,
              role: "maintainer",
              createdAt: now,
              updatedAt: now,
            },
            1,
            audit("project.member_added"),
          );
          assert.equal(added.status, "updated");
          const version =
            added.status === "updated" ? added.project.version : 0;
          const concurrent = await Promise.all([
            projects.updateProjectMemberRole(
              projectId,
              admin.subjectId,
              "viewer",
              version,
              now,
              audit("project.member_role_changed"),
            ),
            projects.updateProjectMemberRole(
              projectId,
              admin.subjectId,
              "owner",
              version,
              now,
              audit("project.member_role_changed"),
            ),
          ]);
          assert.equal(
            concurrent.filter((result) => result.status === "updated").length,
            1,
          );
          const current = (await projects.findProject(projectId))!;
          const memberRole = await projects.findProjectRole(
            projectId,
            admin.subjectId,
          );
          const removal = await projects.removeProjectMember(
            projectId,
            owner.subjectId,
            current.version,
            now,
            audit("project.member_removed"),
          );
          assert.equal(
            removal.status,
            memberRole === "owner" ? "updated" : "last_owner_required",
          );
          assert.ok(
            (await projects.listProjectMembers(projectId)).some(
              (member) => member.role === "owner",
            ),
          );
        },
      );
    } finally {
      await pool.end();
    }
  },
);
