import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { ClientManagementService } from "../src/clients/client-management.service.js";
import { ClientManagementError } from "../src/management/management-error.js";
import type {
  OidcClientAuditRecord,
  ProjectAuditRecord,
} from "../src/persistence/contracts.js";
import { PostgresOidcClientRepository } from "../src/persistence/oidc-client.repository.js";
import { ProjectRepositoryImpl } from "../src/persistence/project.repository.js";
import { ProjectAccessService } from "../src/projects/project-access.js";
import { ProjectManagementService } from "../src/projects/project-management.service.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const owner = { subjectId: "subj_pg_owner", isAdmin: false };
const maintainer = { subjectId: "subj_pg_maintainer", isAdmin: false };
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

    async function reset(now: () => Date = () => new Date()) {
      await pool.query("drop schema public cascade; create schema public");
      await pool.query(schema);
      await pool.query(
        `insert into subjects (subject_id) values ($1), ($2), ($3)`,
        [owner.subjectId, maintainer.subjectId, admin.subjectId],
      );
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
      const repository = new PostgresOidcClientRepository(pool, clientHash);
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
          adminQuotaExempt: false,
          now,
        },
      );
      return { repository, projects, service };
    }

    async function createActive(service: ClientManagementService) {
      const created = await service.create(owner, projectId, input);
      return created.client;
    }

    try {
      await context.test(
        "rejects a client update after its maintainer is concurrently removed",
        async () => {
          const { repository, projects, service } = await reset();
          const created = await service.create(owner, projectId, input);
          await pool.query(
            `insert into project_members (project_id, subject_id, role)
             values ($1, $2, 'maintainer')`,
            [projectId, maintainer.subjectId],
          );
          let releaseWrite!: () => void;
          const writePaused = new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
          let writeReached!: () => void;
          const reachedRepository = new Promise<void>((resolve) => {
            writeReached = resolve;
          });
          const update = repository.updateOidcClientMetadata.bind(repository);
          repository.updateOidcClientMetadata = async (...args) => {
            writeReached();
            await writePaused;
            return update(...args);
          };
          const pending = service.update(
            maintainer,
            projectId,
            created.client.clientId,
            {
              clientVersion: created.client.clientVersion,
              displayName: "Must not commit",
            },
          );
          await reachedRepository;
          const removed = await projects.removeProjectMember(
            projectId,
            maintainer.subjectId,
            1,
            new Date().toISOString(),
            {
              projectId,
              actorSubjectId: owner.subjectId,
              targetSubjectId: maintainer.subjectId,
              action: "project.member_removed",
              changedFields: ["role"],
              previousRole: "maintainer",
              createdAt: new Date().toISOString(),
            },
          );
          assert.equal(removed.status, "updated");
          releaseWrite();
          await assert.rejects(pending);
          const current = await repository.findManagedOidcClient(
            created.client.clientId,
          );
          assert.equal(current?.client.displayName, input.displayName);
          assert.equal(
            (
              await repository.listOidcClientAuditLogs(created.client.clientId)
            ).filter((audit) => audit.action === "client.updated").length,
            0,
          );
        },
      );

      await context.test(
        "rejects client creation after its maintainer is concurrently removed",
        async () => {
          const { repository, projects, service } = await reset();
          await pool.query(
            `insert into project_members (project_id, subject_id, role)
             values ($1, $2, 'maintainer')`,
            [projectId, maintainer.subjectId],
          );
          let releaseWrite!: () => void;
          const writePaused = new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
          let writeReached!: () => void;
          const reachedRepository = new Promise<void>((resolve) => {
            writeReached = resolve;
          });
          const create = repository.createOidcClient.bind(repository);
          repository.createOidcClient = async (...args) => {
            writeReached();
            await writePaused;
            return create(...args);
          };
          const pending = service.create(maintainer, projectId, input);
          await reachedRepository;
          const removed = await projects.removeProjectMember(
            projectId,
            maintainer.subjectId,
            1,
            new Date().toISOString(),
            {
              projectId,
              actorSubjectId: owner.subjectId,
              targetSubjectId: maintainer.subjectId,
              action: "project.member_removed",
              changedFields: ["role"],
              previousRole: "maintainer",
              createdAt: new Date().toISOString(),
            },
          );
          assert.equal(removed.status, "updated");
          releaseWrite();
          await assert.rejects(pending);
          assert.equal(await repository.countOidcClients(), 0);
          assert.equal(
            (await repository.listOidcClientAuditLogs()).filter(
              (audit) => audit.action === "client.created",
            ).length,
            0,
          );
        },
      );

      await context.test(
        "rejects secret rotation after its maintainer is concurrently removed",
        async () => {
          const { repository, projects, service } = await reset();
          const created = await service.create(owner, projectId, webInput);
          await pool.query(
            `insert into project_members (project_id, subject_id, role)
             values ($1, $2, 'maintainer')`,
            [projectId, maintainer.subjectId],
          );
          let releaseWrite!: () => void;
          const writePaused = new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
          let writeReached!: () => void;
          const reachedRepository = new Promise<void>((resolve) => {
            writeReached = resolve;
          });
          const rotate = repository.rotateOidcClientSecret.bind(repository);
          repository.rotateOidcClientSecret = async (...args) => {
            writeReached();
            await writePaused;
            return rotate(...args);
          };
          const pending = service.rotateSecret(
            maintainer,
            projectId,
            created.client.clientId,
            {
              clientVersion: created.client.clientVersion,
              gracePeriodSeconds: 60,
            },
          );
          await reachedRepository;
          const removed = await projects.removeProjectMember(
            projectId,
            maintainer.subjectId,
            1,
            new Date().toISOString(),
            {
              projectId,
              actorSubjectId: owner.subjectId,
              targetSubjectId: maintainer.subjectId,
              action: "project.member_removed",
              changedFields: ["role"],
              previousRole: "maintainer",
              createdAt: new Date().toISOString(),
            },
          );
          assert.equal(removed.status, "updated");
          releaseWrite();
          await assert.rejects(pending);
          const current = await repository.findManagedOidcClient(
            created.client.clientId,
          );
          assert.equal(current?.secrets.length, 1);
          assert.equal(
            (
              await repository.listOidcClientAuditLogs(created.client.clientId)
            ).filter((audit) => audit.action === "client.secret_rotated")
              .length,
            0,
          );
        },
      );

      await context.test(
        "rechecks active subject status inside the member transaction",
        async () => {
          await reset();
          const projects = new ProjectRepositoryImpl(
            () => pool,
            async () => true,
          );
          await pool.query(
            "update subjects set status = 'disabled' where subject_id = $1",
            [maintainer.subjectId],
          );
          const now = new Date().toISOString();
          const added = await projects.addProjectMember(
            {
              projectId,
              subjectId: maintainer.subjectId,
              role: "viewer",
              createdAt: now,
              updatedAt: now,
            },
            1,
            {
              projectId,
              actorSubjectId: owner.subjectId,
              targetSubjectId: maintainer.subjectId,
              action: "project.member_added",
              changedFields: ["role"],
              newRole: "viewer",
              createdAt: now,
            },
          );
          assert.equal(added.status, "subject_not_found");
          assert.equal(
            await projects.findProjectRole(projectId, maintainer.subjectId),
            null,
          );
          assert.equal(
            (await projects.listProjectAuditLogs(projectId, 100)).filter(
              (audit) =>
                audit.action === "project.member_added" &&
                audit.targetSubjectId === maintainer.subjectId,
            ).length,
            0,
          );
        },
      );

      await context.test(
        "serializes active project quota by creating subject",
        async () => {
          const { projects } = await reset();
          await pool.query(
            "update projects set created_by_subject_id = $2 where project_id = $1",
            [projectId, admin.subjectId],
          );
          let projectSequence = 0;
          const service = new ProjectManagementService(
            projects,
            () => new Date(),
            () => `subject_project_${++projectSequence}`,
            { maxActiveProjects: 1, adminQuotaExempt: false },
          );
          const results = await Promise.allSettled([
            service.create(owner, { name: "First", description: "" }),
            service.create(owner, { name: "Second", description: "" }),
          ]);
          assert.equal(
            results.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const rejected = results.find(
            (result) => result.status === "rejected",
          ) as PromiseRejectedResult;
          assert.ok(rejected.reason instanceof ClientManagementError);
          assert.equal(rejected.reason.code, "project_quota_exceeded");
          assert.equal(
            Number(
              (
                await pool.query(
                  "select count(*)::int as count from projects where created_by_subject_id = $1 and status = 'active'",
                  [owner.subjectId],
                )
              ).rows[0]?.["count"],
            ),
            1,
          );
        },
      );

      await context.test(
        "enforces subject client quota across concurrent projects",
        async () => {
          const { repository, projects } = await reset();
          const secondProjectId = "pg_project_second";
          await pool.query(
            `insert into projects (project_id, name, created_by_subject_id)
             values ($1, 'Second project', $2)`,
            [secondProjectId, owner.subjectId],
          );
          await pool.query(
            `insert into project_members (project_id, subject_id, role)
             values ($1, $2, 'owner')`,
            [secondProjectId, owner.subjectId],
          );
          const service = new ClientManagementService(
            repository,
            new ProjectAccessService(projects),
            "test",
            {
              createClientId: () => `subject_client_${++sequence}`,
              maxClientsPerProject: 10,
              maxClientsPerSubject: 1,
              adminQuotaExempt: false,
            },
          );
          const results = await Promise.allSettled([
            service.create(owner, projectId, input),
            service.create(owner, secondProjectId, input),
          ]);
          assert.equal(
            results.filter((result) => result.status === "fulfilled").length,
            1,
          );
          assert.equal(
            Number(
              (
                await pool.query(
                  `select count(*)::int as count from oidc_clients c
                   join projects p on p.project_id = c.project_id
                   where p.created_by_subject_id = $1 and c.lifecycle_status <> 'disabled'`,
                  [owner.subjectId],
                )
              ).rows[0]?.["count"],
            ),
            1,
          );
        },
      );

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
        "activates concurrent revision saves with latest winner",
        async () => {
          const { repository, service } = await reset();
          const active = await createActive(service);
          await Promise.allSettled([
            service.saveRevision(owner, projectId, active.clientId, {
              redirectUris: ["http://localhost:3002/first"],
            }),
            service.saveRevision(owner, projectId, active.clientId, {
              redirectUris: ["http://localhost:3002/second"],
            }),
          ]);
          const current = await repository.findManagedOidcClient(
            active.clientId,
          );
          assert.equal(current?.client.lifecycleStatus, "active");
          assert.ok(current?.activeRevision);
          assert.equal(current?.proposedRevision, null);
        },
      );

      await context.test(
        "keeps revision save and disable atomic when racing",
        async () => {
          const { repository, service } = await reset();
          const active = await createActive(service);
          const results = await Promise.allSettled([
            service.saveRevision(owner, projectId, active.clientId, {
              redirectUris: ["http://localhost:3002/race"],
            }),
            service.disable(owner, projectId, active.clientId, {
              clientVersion: active.clientVersion,
            }),
          ]);
          assert.ok(
            results.filter((result) => result.status === "fulfilled").length >=
              1,
          );
          const current = await repository.findManagedOidcClient(
            active.clientId,
          );
          assert.ok(current);
          assert.equal(current?.proposedRevision, null);
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

      await context.test("stacks successive approved revisions", async () => {
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
        assert.equal(second.proposedRevision, null);
        const third = await service.saveRevision(
          owner,
          projectId,
          active.clientId,
          {
            scopeWhitelist: ["openid", "profile", "email"],
          },
        );
        assert.equal(third.activeRevision?.revisionNumber, 3);
        const fourth = await service.saveRevision(
          owner,
          projectId,
          active.clientId,
          {
            redirectUris: ["http://localhost:3002/fourth"],
          },
        );
        assert.equal(fourth.activeRevision?.revisionNumber, 4);
        assert.deepEqual(fourth.activeRevision?.scopeWhitelist, [
          "openid",
          "profile",
          "email",
        ]);
      });

      await context.test(
        "rolls back revision activation when audit insertion fails",
        async () => {
          const { repository, service } = await reset();
          const active = await createActive(service);
          const timestamp = new Date().toISOString();
          const invalidAudit = {
            clientId: active.clientId,
            actorSubjectId: admin.subjectId,
            action: "revision.activated",
            changedFields: [1n] as unknown as string[],
            createdAt: timestamp,
          } satisfies OidcClientAuditRecord;
          await assert.rejects(() =>
            repository.saveOidcClientRevision(
              active.clientId,
              {
                revisionId: 0,
                clientId: active.clientId,
                revisionNumber: 2,
                status: "approved",
                redirectUris: ["http://localhost:3002/rollback"],
                postLogoutRedirectUris: [],
                scopeWhitelist: ["openid"],
                createdAt: timestamp,
                updatedAt: timestamp,
                version: 1,
              },
              null,
              null,
              [invalidAudit],
              undefined,
              { actor: admin, projectId, action: "write_client" },
            ),
          );
          const current = await repository.findManagedOidcClient(
            active.clientId,
          );
          assert.equal(current?.activeRevision?.revisionNumber, 1);
          assert.equal(current?.proposedRevision, null);
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
