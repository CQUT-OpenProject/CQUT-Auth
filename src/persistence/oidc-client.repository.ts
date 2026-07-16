import type { Pool, PoolClient } from "pg";
import type {
  ActiveOidcClientRecord,
  ClientProjectLimits,
  ClientSecurityMutationResult,
  ClientRevisionStatus,
  ManagedOidcClientRecord,
  OidcClientAuditRecord,
  OidcClientRecord,
  OidcClientSecretRecord,
  OidcClientRepository,
  OidcClientRevisionRecord,
  ProjectRecord,
  RevisionMutationResult,
} from "./contracts.js";
import {
  assertProjectAccess,
  type ProjectWriteAuthorization,
} from "../projects/project-access.js";
import { ClientManagementError } from "../management/management-error.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

class OidcClientRepositoryImpl implements OidcClientRepository {
  private readonly clients = new Map<string, OidcClientRecord>();
  private readonly revisions = new Map<number, OidcClientRevisionRecord>();
  private readonly secrets = new Map<string, OidcClientSecretRecord>();
  private readonly audits: OidcClientAuditRecord[] = [];
  private readonly clientQuotaSubjects = new Map<string, string | null>();
  private nextRevisionId = 1;

  constructor(
    private readonly poolProvider: () => Pool | undefined,
    private readonly clientIdHasher: (clientId: string) => string = (value) =>
      value,
    private readonly revokeMemoryArtifactsByClientId: (
      clientId: string,
    ) => Promise<void> = async () => {},
    private readonly withMemoryProjectWrite: <T>(
      authorization: ProjectWriteAuthorization,
      clientProjectId: string,
      mutation: (project: ProjectRecord) => Promise<T>,
    ) => Promise<T> = async (authorization, _clientProjectId, mutation) =>
      mutation({
        projectId: authorization.projectId,
        name: "",
        description: "",
        status: "active",
        createdBySubjectId: null,
        version: 1,
        createdAt: "",
        updatedAt: "",
      }),
  ) {}

  private async transaction<T>(
    pool: Pool,
    fn: (connection: PoolClient, rollback: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const connection = await pool.connect();
    let rolledBack = false;
    const rollback = async () => {
      await connection.query("rollback");
      rolledBack = true;
    };
    try {
      await connection.query("begin");
      const result = await fn(connection, rollback);
      if (!rolledBack) {
        await connection.query("commit");
      }
      return result;
    } catch (error) {
      if (!rolledBack) {
        await connection.query("rollback");
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async upsertOidcClient(
    active: ActiveOidcClientRecord,
  ): Promise<ActiveOidcClientRecord> {
    const pool = this.poolProvider();
    if (!pool) {
      const revision = this.assignRevisionId(active.activeRevision);
      this.revisions.set(revision.revisionId, revision);
      this.clients.set(active.clientId, {
        ...this.clientPart(active),
        activeRevisionId: revision.revisionId,
      });
      this.clientQuotaSubjects.set(active.clientId, null);
      this.replaceMemoryBootstrapSecrets(active);
      return this.toActive(
        this.clients.get(active.clientId)!,
        revision,
        this.usableMemorySecrets(active.clientId),
      );
    }
    return this.transaction(pool, async (connection) => {
      return this.upsertActive(connection, active);
    });
  }

  async countOidcClients(): Promise<number> {
    const pool = this.poolProvider();
    if (!pool) return this.clients.size;
    const result = await pool.query(
      "select count(*)::int as count from oidc_clients",
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async initializeOidcClientsIfEmpty(
    clients: ActiveOidcClientRecord[],
    audits: OidcClientAuditRecord[],
  ): Promise<{ imported: boolean; count: number }> {
    const pool = this.poolProvider();
    if (!pool) {
      if (this.clients.size > 0) return { imported: false, count: 0 };
      for (const client of clients) await this.upsertOidcClient(client);
      this.audits.push(
        ...audits.map((audit) => {
          const revision = this.memoryManaged(audit.clientId)?.activeRevision;
          return audit.action.startsWith("revision.") && revision
            ? {
                ...audit,
                revisionId: revision.revisionId,
                revisionNumber: revision.revisionNumber,
              }
            : audit;
        }),
      );
      return { imported: true, count: clients.length };
    }
    return this.transaction(pool, async (connection) => {
      await connection.query(
        "select pg_advisory_xact_lock(hashtext('cqut-auth:oidc-client-initialize'))",
      );
      const count = await connection.query(
        "select count(*)::int as count from oidc_clients",
      );
      if (Number(count.rows[0]?.count ?? 0) > 0) {
        return { imported: false, count: 0 };
      }
      const revisionIds = new Map<string, { id: number; number: number }>();
      for (const client of clients) {
        const inserted = await this.upsertActive(connection, client);
        revisionIds.set(client.clientId, {
          id: inserted.activeRevisionId,
          number: inserted.activeRevision.revisionNumber,
        });
      }
      for (const audit of audits) {
        const revision = revisionIds.get(audit.clientId);
        await this.insertAudit(connection, {
          ...audit,
          ...(audit.action.startsWith("revision.") && revision
            ? { revisionId: revision.id, revisionNumber: revision.number }
            : {}),
        });
      }
      return { imported: true, count: clients.length };
    });
  }

  async createOidcClient(
    client: OidcClientRecord,
    revision: OidcClientRevisionRecord,
    secret: OidcClientSecretRecord | undefined,
    audits: OidcClientAuditRecord[],
    projectLimits: ClientProjectLimits | undefined,
    authorization: ProjectWriteAuthorization,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.withMemoryProjectWrite(
        authorization,
        client.projectId,
        async (project) => {
          if (this.clients.has(client.clientId)) {
            throw new Error(`oidc client already exists: ${client.clientId}`);
          }
          if (
            projectLimits &&
            (this.projectQuotaExceeded(client, projectLimits) ||
              this.subjectClientQuotaExceeded(
                project.createdBySubjectId,
                projectLimits.maxNonDisabledClientsPerSubject,
              ))
          )
            return null;
          const assigned = this.assignRevisionId(revision);
          this.clients.set(client.clientId, client);
          this.clientQuotaSubjects.set(
            client.clientId,
            project.createdBySubjectId,
          );
          this.revisions.set(assigned.revisionId, assigned);
          if (secret) this.secrets.set(secret.secretId, secret);
          this.audits.push(
            ...audits.map((audit) => ({
              ...audit,
              ...(audit.action.startsWith("revision.")
                ? {
                    revisionId: assigned.revisionId,
                    revisionNumber: assigned.revisionNumber,
                  }
                : {}),
            })),
          );
          return this.memoryManaged(client.clientId);
        },
      );
    }
    const success = await this.transaction(
      pool,
      async (connection, rollback) => {
        const project = await this.authorizeProjectWrite(
          connection,
          authorization,
        );
        if (client.projectId !== authorization.projectId)
          throw new ClientManagementError(
            404,
            "not_found",
            "project not found",
          );
        if (projectLimits) {
          await this.lockQuotaSubject(connection, project.createdBySubjectId);
          const count = await connection.query(
            `select
             count(*) filter (where c.project_id = $1 and c.lifecycle_status <> 'disabled')::int as project_non_disabled,
             count(*) filter (where p.created_by_subject_id = $2 and c.lifecycle_status <> 'disabled')::int as subject_non_disabled
           from oidc_clients c join projects p on p.project_id = c.project_id`,
            [client.projectId, project.createdBySubjectId],
          );
          if (
            Number(count.rows[0]?.["project_non_disabled"] ?? 0) >=
              projectLimits.maxNonDisabledClients ||
            (project.createdBySubjectId !== null &&
              Number(count.rows[0]?.["subject_non_disabled"] ?? 0) >=
                projectLimits.maxNonDisabledClientsPerSubject)
          ) {
            await rollback();
            return false;
          }
        }
        await connection.query(
          this.insertClientSql(),
          this.clientValues(client),
        );
        const inserted = await this.insertRevision(connection, revision);
        if (secret) await this.insertSecret(connection, secret);
        for (const audit of audits) {
          await this.insertAudit(connection, {
            ...audit,
            ...(audit.action.startsWith("revision.")
              ? {
                  revisionId: inserted.revisionId,
                  revisionNumber: inserted.revisionNumber,
                }
              : {}),
          });
        }
        return true;
      },
    );
    return success ? this.findManagedOidcClient(client.clientId) : null;
  }

  async updateOidcClientMetadata(
    clientId: string,
    patch: Pick<OidcClientRecord, "displayName" | "description" | "updatedAt">,
    expectedVersion: number,
    audit: OidcClientAuditRecord,
    authorization: ProjectWriteAuthorization,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const current = this.clients.get(clientId);
      return this.withMemoryProjectWrite(
        authorization,
        current?.projectId ?? "",
        async () => {
          if (!current || current.version !== expectedVersion) return null;
          this.clients.set(clientId, {
            ...current,
            ...patch,
            version: current.version + 1,
          });
          this.audits.push(audit);
          return this.memoryManaged(clientId);
        },
      );
    }
    const success = await this.transaction(
      pool,
      async (connection, rollback) => {
        await this.authorizeProjectWrite(connection, authorization, clientId);
        const result = await connection.query(
          `update oidc_clients set display_name = $2, description = $3,
           updated_at = $4::timestamptz, version = version + 1
         where client_id = $1 and version = $5`,
          [
            clientId,
            patch.displayName,
            patch.description,
            patch.updatedAt,
            expectedVersion,
          ],
        );
        if (result.rowCount !== 1) {
          await rollback();
          return false;
        }
        await this.insertAudit(connection, audit);
        return true;
      },
    );
    return success ? this.findManagedOidcClient(clientId) : null;
  }

  async saveOidcClientRevision(
    clientId: string,
    revision: OidcClientRevisionRecord,
    expectedRevisionId: number | null,
    expectedRevisionVersion: number | null,
    audits: OidcClientAuditRecord[],
    projectLimits: ClientProjectLimits | undefined,
    authorization: ProjectWriteAuthorization,
  ): Promise<RevisionMutationResult> {
    const pool = this.poolProvider();
    if (!pool) {
      const managed = this.memoryManaged(clientId);
      return this.withMemoryProjectWrite(
        authorization,
        managed?.client.projectId ?? "",
        async (project) => {
          if (!managed) return { status: "version_conflict" };
          if (
            revision.status === "pending" &&
            projectLimits &&
            this.memoryPendingQuotaExceeded(
              managed.client.projectId,
              project.createdBySubjectId,
              projectLimits,
            )
          )
            return { status: "pending_quota_exceeded" };
          if (expectedRevisionId === null) {
            if (
              managed.proposedRevision?.status === "draft" ||
              managed.proposedRevision?.status === "pending"
            )
              return { status: "version_conflict" };
            const assigned = this.assignRevisionId(revision);
            this.revisions.set(assigned.revisionId, assigned);
            this.pushRevisionAudits(audits, assigned);
          } else {
            const current = this.revisions.get(expectedRevisionId);
            if (
              !current ||
              current.clientId !== clientId ||
              current.version !== expectedRevisionVersion ||
              current.status !== "draft"
            )
              return { status: "version_conflict" };
            const next = {
              ...revision,
              revisionId: current.revisionId,
              revisionNumber: current.revisionNumber,
              version: current.version + 1,
            };
            this.revisions.set(current.revisionId, next);
            this.pushRevisionAudits(audits, next);
          }
          return this.updatedResult(clientId);
        },
      );
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const project = await this.authorizeProjectWrite(
        connection,
        authorization,
        clientId,
      );
      if (revision.status === "pending" && projectLimits) {
        await this.lockQuotaSubject(connection, project.createdBySubjectId);
        if (
          await this.pendingQuotaExceeded(
            connection,
            authorization.projectId,
            project.createdBySubjectId,
            projectLimits,
          )
        ) {
          await connection.query("rollback");
          return { status: "pending_quota_exceeded" };
        }
      }
      let saved: OidcClientRevisionRecord;
      if (expectedRevisionId === null) {
        const open = await connection.query(
          `select 1 from oidc_client_revisions
           where client_id = $1 and review_status in ('draft', 'pending') limit 1`,
          [clientId],
        );
        if (open.rowCount) {
          await connection.query("rollback");
          return { status: "version_conflict" };
        }
        saved = await this.insertRevision(connection, revision);
      } else {
        const result = await connection.query(
          `update oidc_client_revisions set redirect_uris = $4::jsonb,
             post_logout_redirect_uris = $5::jsonb, scope_whitelist = $6::jsonb,
             rejection_reason = null, updated_at = $7::timestamptz, version = version + 1
           where client_id = $1 and revision_id = $2 and version = $3 and review_status = 'draft'
           returning *`,
          [
            clientId,
            expectedRevisionId,
            expectedRevisionVersion,
            JSON.stringify(revision.redirectUris),
            JSON.stringify(revision.postLogoutRedirectUris),
            JSON.stringify(revision.scopeWhitelist),
            revision.updatedAt,
          ],
        );
        if (result.rowCount !== 1) {
          await connection.query("rollback");
          return { status: "version_conflict" };
        }
        saved = this.mapRevisionRow(result.rows[0])!;
      }
      for (const audit of audits) {
        await this.insertAudit(connection, {
          ...audit,
          revisionId: saved.revisionId,
          revisionNumber: saved.revisionNumber,
        });
      }
      await connection.query("commit");
      return this.updatedResult(clientId);
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async transitionOidcClientRevision(
    clientId: string,
    revisionId: number,
    expectedVersion: number,
    nextStatus: ClientRevisionStatus,
    reason: string | undefined,
    audit: OidcClientAuditRecord,
    projectLimits: ClientProjectLimits | undefined,
    authorization: ProjectWriteAuthorization,
  ): Promise<RevisionMutationResult> {
    const pool = this.poolProvider();
    if (!pool) {
      const current = this.revisions.get(revisionId);
      const client = this.clients.get(clientId);
      return this.withMemoryProjectWrite(
        authorization,
        client?.projectId ?? "",
        async (project) => {
          if (
            !current ||
            current.clientId !== clientId ||
            current.version !== expectedVersion
          )
            return { status: "version_conflict" };
          if (
            nextStatus === "pending" &&
            projectLimits &&
            this.memoryPendingQuotaExceeded(
              client!.projectId,
              project.createdBySubjectId,
              projectLimits,
            )
          )
            return { status: "pending_quota_exceeded" };
          const next = {
            ...current,
            status: nextStatus,
            rejectionReason: reason,
            updatedAt: audit.createdAt,
            version: current.version + 1,
          };
          this.revisions.set(revisionId, next);
          this.audits.push({
            ...audit,
            revisionId,
            revisionNumber: current.revisionNumber,
          });
          return this.updatedResult(clientId);
        },
      );
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const project = await this.authorizeProjectWrite(
        connection,
        authorization,
        clientId,
      );
      if (nextStatus === "pending" && projectLimits) {
        await this.lockQuotaSubject(connection, project.createdBySubjectId);
        if (
          await this.pendingQuotaExceeded(
            connection,
            authorization.projectId,
            project.createdBySubjectId,
            projectLimits,
          )
        ) {
          await connection.query("rollback");
          return { status: "pending_quota_exceeded" };
        }
      }
      const result = await connection.query(
        `update oidc_client_revisions set review_status = $4, rejection_reason = $5,
           updated_at = $6::timestamptz, version = version + 1
         where client_id = $1 and revision_id = $2 and version = $3 returning *`,
        [
          clientId,
          revisionId,
          expectedVersion,
          nextStatus,
          reason ?? null,
          audit.createdAt,
        ],
      );
      if (result.rowCount !== 1) {
        await connection.query("rollback");
        return { status: "version_conflict" };
      }
      const revision = this.mapRevisionRow(result.rows[0])!;
      await this.insertAudit(connection, {
        ...audit,
        revisionId,
        revisionNumber: revision.revisionNumber,
      });
      await connection.query("commit");
      return this.updatedResult(clientId);
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async approveOidcClientRevision(
    clientId: string,
    revisionId: number,
    expectedVersion: number,
    audits: OidcClientAuditRecord[],
    authorization: ProjectWriteAuthorization,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const client = this.clients.get(clientId);
      return this.withMemoryProjectWrite(
        authorization,
        client?.projectId ?? "",
        async () => {
          const revision = this.revisions.get(revisionId);
          if (
            !client ||
            client.lifecycleStatus === "disabled" ||
            !revision ||
            revision.clientId !== clientId ||
            revision.status !== "pending" ||
            revision.version !== expectedVersion
          )
            return null;
          const approved = {
            ...revision,
            status: "approved" as const,
            updatedAt: audits[0]!.createdAt,
            version: revision.version + 1,
          };
          this.revisions.set(revisionId, approved);
          this.clients.set(clientId, {
            ...client,
            lifecycleStatus: "active",
            activeRevisionId: revisionId,
            updatedAt: audits[0]!.createdAt,
            version: client.version + 1,
          });
          this.pushRevisionAudits(audits, approved);
          return this.memoryManaged(clientId);
        },
      );
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      await this.authorizeProjectWrite(connection, authorization, clientId);
      const clientResult = await connection.query(
        "select * from oidc_clients where client_id = $1",
        [clientId],
      );
      if (
        !clientResult.rows[0] ||
        clientResult.rows[0]["lifecycle_status"] === "disabled"
      ) {
        await connection.query("rollback");
        return null;
      }
      const revisionResult = await connection.query(
        `update oidc_client_revisions set review_status = 'approved', rejection_reason = null,
           updated_at = $4::timestamptz, version = version + 1
         where client_id = $1 and revision_id = $2 and version = $3 and review_status = 'pending'
         returning *`,
        [clientId, revisionId, expectedVersion, audits[0]!.createdAt],
      );
      if (revisionResult.rowCount !== 1) {
        await connection.query("rollback");
        return null;
      }
      const revision = this.mapRevisionRow(revisionResult.rows[0])!;
      await connection.query(
        `update oidc_clients set lifecycle_status = 'active', active_revision_id = $2,
           updated_at = $3::timestamptz, version = version + 1 where client_id = $1`,
        [clientId, revisionId, audits[0]!.createdAt],
      );
      for (const audit of audits) {
        await this.insertAudit(connection, {
          ...audit,
          revisionId,
          revisionNumber: revision.revisionNumber,
        });
      }
      await connection.query("commit");
      return this.findManagedOidcClient(clientId);
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async disableOidcClient(
    clientId: string,
    expectedVersion: number,
    updatedAt: string,
    audits: OidcClientAuditRecord[],
    authorization: ProjectWriteAuthorization,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const client = this.clients.get(clientId);
      return this.withMemoryProjectWrite(
        authorization,
        client?.projectId ?? "",
        async () => {
          if (!client || client.version !== expectedVersion) return null;
          this.clients.set(clientId, {
            ...client,
            lifecycleStatus: "disabled",
            authorizationGeneration: client.authorizationGeneration + 1,
            updatedAt,
            version: client.version + 1,
          });
          const cancelled = [...this.revisions.values()].filter(
            (revision) =>
              revision.clientId === clientId &&
              (revision.status === "draft" || revision.status === "pending"),
          );
          for (const revision of cancelled) {
            this.revisions.set(revision.revisionId, {
              ...revision,
              status: "cancelled",
              updatedAt,
              version: revision.version + 1,
            });
          }
          for (const [secretId, secret] of this.secrets.entries()) {
            if (secret.clientId === clientId && secret.status !== "revoked") {
              this.secrets.set(secretId, {
                ...secret,
                status: "revoked",
                revokedAt: updatedAt,
                version: secret.version + 1,
              });
              this.audits.push({
                ...audits[0]!,
                action: "client.secret_revoked",
                secretId,
                changedFields: ["status", "revokedAt"],
              });
            }
          }
          await this.revokeMemoryArtifactsByClientId(clientId);
          this.audits.push(
            ...audits.map((audit) => {
              if (audit.action !== "revision.cancelled") return audit;
              const revision = cancelled[0];
              return revision
                ? {
                    ...audit,
                    revisionId: revision.revisionId,
                    revisionNumber: revision.revisionNumber,
                    previousRevisionStatus: revision.status,
                  }
                : audit;
            }),
          );
          return this.memoryManaged(clientId);
        },
      );
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      await this.authorizeProjectWrite(connection, authorization, clientId);
      const current = await connection.query(
        "select * from oidc_clients where client_id = $1",
        [clientId],
      );
      if (
        !current.rows[0] ||
        Number(current.rows[0]["version"]) !== expectedVersion
      ) {
        await connection.query("rollback");
        return null;
      }
      const result = await connection.query(
        `update oidc_clients set lifecycle_status = 'disabled', updated_at = now(),
           authorization_generation = authorization_generation + 1,
           version = version + 1 where client_id = $1 and version = $2`,
        [clientId, expectedVersion],
      );
      if (result.rowCount !== 1) {
        await connection.query("rollback");
        return null;
      }
      const cancelled = await connection.query(
        `update oidc_client_revisions set review_status = 'cancelled', rejection_reason = null,
           updated_at = $2::timestamptz, version = version + 1
         where client_id = $1 and review_status in ('draft', 'pending')
         returning revision_id, revision_number, review_status`,
        [clientId, updatedAt],
      );
      const revokedSecrets = await connection.query(
        `update oidc_client_secrets
         set status = 'revoked', revoked_at = $2::timestamptz, version = version + 1
         where client_id = $1 and status <> 'revoked' returning secret_id`,
        [clientId, updatedAt],
      );
      await this.deleteClientArtifacts(connection, clientId);
      for (const audit of audits) {
        if (audit.action !== "revision.cancelled") {
          await this.insertAudit(connection, audit);
          continue;
        }
        for (const revision of cancelled.rows) {
          await this.insertAudit(connection, {
            ...audit,
            revisionId: Number(revision["revision_id"]),
            revisionNumber: Number(revision["revision_number"]),
          });
        }
      }
      for (const secretRow of revokedSecrets.rows) {
        await this.insertAudit(connection, {
          ...audits[0]!,
          action: "client.secret_revoked",
          secretId: String(secretRow["secret_id"]),
          changedFields: ["status", "revokedAt"],
        });
      }
      await connection.query("commit");
      return this.findManagedOidcClient(clientId);
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async rotateOidcClientSecret(
    clientId: string,
    secret: OidcClientSecretRecord,
    expectedClientVersion: number,
    gracePeriodSeconds: number,
    minimumRotationIntervalSeconds: number,
    audit: OidcClientAuditRecord,
    authorization: ProjectWriteAuthorization,
  ): Promise<ClientSecurityMutationResult> {
    const pool = this.poolProvider();
    if (!pool) {
      const client = this.clients.get(clientId);
      return this.withMemoryProjectWrite(
        authorization,
        client?.projectId ?? "",
        async () => {
          if (!client || client.version !== expectedClientVersion) {
            return { status: "version_conflict" };
          }
          const usable = this.usableMemorySecrets(clientId, secret.createdAt);
          if (usable.length >= 2) return { status: "secret_limit_exceeded" };
          const newest = [...this.secrets.values()]
            .filter((candidate) => candidate.clientId === clientId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          if (newest) {
            const retryAfterSeconds = Math.ceil(
              (new Date(newest.createdAt).getTime() +
                minimumRotationIntervalSeconds * 1000 -
                new Date(secret.createdAt).getTime()) /
                1000,
            );
            if (retryAfterSeconds > 0) {
              return { status: "secret_rotation_cooldown", retryAfterSeconds };
            }
          }
          const active = usable.find(
            (candidate) => candidate.status === "active",
          );
          if (active) {
            this.secrets.set(active.secretId, {
              ...active,
              status: gracePeriodSeconds === 0 ? "revoked" : "retiring",
              expiresAt:
                gracePeriodSeconds === 0
                  ? active.expiresAt
                  : new Date(
                      new Date(secret.createdAt).getTime() +
                        gracePeriodSeconds * 1000,
                    ).toISOString(),
              revokedAt: gracePeriodSeconds === 0 ? secret.createdAt : null,
              version: active.version + 1,
            });
            this.audits.push({
              ...audit,
              action:
                gracePeriodSeconds === 0
                  ? "client.secret_revoked"
                  : "client.secret_retired",
              secretId: active.secretId,
              changedFields: [
                "status",
                gracePeriodSeconds === 0 ? "revokedAt" : "expiresAt",
              ],
            });
          }
          this.secrets.set(secret.secretId, secret);
          this.clients.set(clientId, {
            ...client,
            updatedAt: secret.createdAt,
            version: client.version + 1,
          });
          this.audits.push(audit);
          const terminal = [...this.secrets.values()]
            .filter(
              (candidate) =>
                candidate.clientId === clientId &&
                (candidate.status === "revoked" ||
                  (candidate.status === "retiring" &&
                    candidate.expiresAt !== null &&
                    candidate.expiresAt <= secret.createdAt)),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          for (const expired of terminal.slice(100)) {
            this.secrets.delete(expired.secretId);
          }
          return {
            status: "updated",
            client: this.memoryManaged(clientId)!,
            secret,
          };
        },
      );
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      await this.authorizeProjectWrite(connection, authorization, clientId);
      const current = await connection.query(
        "select version from oidc_clients where client_id = $1",
        [clientId],
      );
      if (Number(current.rows[0]?.["version"]) !== expectedClientVersion) {
        await connection.query("rollback");
        return { status: "version_conflict" };
      }
      const usable = await connection.query(
        `select secret_id from oidc_client_secrets
         where client_id = $1 and status in ('active', 'retiring')
           and (expires_at is null or expires_at > now())
         for update`,
        [clientId],
      );
      if ((usable.rowCount ?? 0) >= 2) {
        await connection.query("rollback");
        return { status: "secret_limit_exceeded" };
      }
      const newest =
        minimumRotationIntervalSeconds > 0
          ? await connection.query(
              `select greatest(0, least(2147483647, ceil(extract(epoch from
                 (created_at + ($2 * interval '1 second') - now())))))::int
                 as retry_after_seconds
               from oidc_client_secrets where client_id = $1
               order by created_at desc limit 1`,
              [clientId, minimumRotationIntervalSeconds],
            )
          : undefined;
      const retryAfterSeconds = Number(
        newest?.rows[0]?.["retry_after_seconds"] ?? 0,
      );
      if (retryAfterSeconds > 0) {
        await connection.query("rollback");
        return { status: "secret_rotation_cooldown", retryAfterSeconds };
      }
      const transitioned =
        gracePeriodSeconds === 0
          ? await connection.query(
              `update oidc_client_secrets set status = 'revoked', revoked_at = now(),
             version = version + 1 where client_id = $1 and status = 'active'
             returning secret_id`,
              [clientId],
            )
          : await connection.query(
              `update oidc_client_secrets set status = 'retiring',
             expires_at = now() + ($2 * interval '1 second'), version = version + 1
           where client_id = $1 and status = 'active' returning secret_id`,
              [clientId, gracePeriodSeconds],
            );
      const insertedSecret = await this.insertSecret(
        connection,
        {
          ...secret,
        },
        true,
      );
      await connection.query(
        `update oidc_clients set updated_at = now(), version = version + 1
         where client_id = $1 and version = $2`,
        [clientId, expectedClientVersion],
      );
      await this.insertAudit(connection, audit);
      for (const secretRow of transitioned.rows) {
        await this.insertAudit(connection, {
          ...audit,
          action:
            gracePeriodSeconds === 0
              ? "client.secret_revoked"
              : "client.secret_retired",
          secretId: String(secretRow["secret_id"]),
          changedFields: [
            "status",
            gracePeriodSeconds === 0 ? "revokedAt" : "expiresAt",
          ],
        });
      }
      await connection.query(
        `delete from oidc_client_secrets where secret_id in (
           select secret_id from oidc_client_secrets
           where client_id = $1
             and (status = 'revoked' or (status = 'retiring' and expires_at <= now()))
           order by created_at desc, secret_id
           offset 100
         )`,
        [clientId],
      );
      await connection.query("commit");
      return {
        status: "updated",
        client: (await this.findManagedOidcClient(clientId))!,
        secret: insertedSecret,
      };
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async revokeOidcClientSecret(
    clientId: string,
    secretId: string,
    expectedClientVersion: number,
    expectedSecretVersion: number,
    updatedAt: string,
    audit: OidcClientAuditRecord,
    authorization: ProjectWriteAuthorization,
  ): Promise<ClientSecurityMutationResult> {
    const pool = this.poolProvider();
    if (!pool) {
      const client = this.clients.get(clientId);
      return this.withMemoryProjectWrite(
        authorization,
        client?.projectId ?? "",
        async () => {
          if (!client || client.version !== expectedClientVersion) {
            return { status: "version_conflict" };
          }
          const secret = this.secrets.get(secretId);
          if (!secret || secret.clientId !== clientId)
            return { status: "secret_not_found" };
          if (
            secret.version !== expectedSecretVersion ||
            secret.status === "revoked"
          ) {
            return { status: "version_conflict" };
          }
          this.secrets.set(secretId, {
            ...secret,
            status: "revoked",
            revokedAt: updatedAt,
            version: secret.version + 1,
          });
          this.clients.set(clientId, {
            ...client,
            updatedAt,
            version: client.version + 1,
          });
          this.audits.push(audit);
          return { status: "updated", client: this.memoryManaged(clientId)! };
        },
      );
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      await this.authorizeProjectWrite(connection, authorization, clientId);
      const client = await connection.query(
        "select version from oidc_clients where client_id = $1",
        [clientId],
      );
      if (Number(client.rows[0]?.["version"]) !== expectedClientVersion) {
        await connection.query("rollback");
        return { status: "version_conflict" };
      }
      const existing = await connection.query(
        "select 1 from oidc_client_secrets where client_id = $1 and secret_id = $2",
        [clientId, secretId],
      );
      if (!existing.rowCount) {
        await connection.query("rollback");
        return { status: "secret_not_found" };
      }
      const result = await connection.query(
        `update oidc_client_secrets set status = 'revoked', revoked_at = $4::timestamptz,
           version = version + 1
         where client_id = $1 and secret_id = $2 and version = $3 and status <> 'revoked'`,
        [clientId, secretId, expectedSecretVersion, updatedAt],
      );
      if (result.rowCount !== 1) {
        await connection.query("rollback");
        return { status: "version_conflict" };
      }
      await connection.query(
        `update oidc_clients set updated_at = now(), version = version + 1
         where client_id = $1 and version = $2`,
        [clientId, expectedClientVersion],
      );
      await this.insertAudit(connection, audit);
      await connection.query("commit");
      return {
        status: "updated",
        client: (await this.findManagedOidcClient(clientId))!,
      };
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async revokeOidcClientAuthorizations(
    clientId: string,
    expectedClientVersion: number,
    updatedAt: string,
    audit: OidcClientAuditRecord,
    authorization: ProjectWriteAuthorization,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const client = this.clients.get(clientId);
      return this.withMemoryProjectWrite(
        authorization,
        client?.projectId ?? "",
        async () => {
          if (!client || client.version !== expectedClientVersion) return null;
          await this.revokeMemoryArtifactsByClientId(clientId);
          this.clients.set(clientId, {
            ...client,
            authorizationGeneration: client.authorizationGeneration + 1,
            updatedAt,
            version: client.version + 1,
          });
          this.audits.push(audit);
          return this.memoryManaged(clientId);
        },
      );
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      await this.authorizeProjectWrite(connection, authorization, clientId);
      const result = await connection.query(
        `update oidc_clients set updated_at = now(),
           authorization_generation = authorization_generation + 1,
           version = version + 1
         where client_id = $1 and version = $2`,
        [clientId, expectedClientVersion],
      );
      if (result.rowCount !== 1) {
        await connection.query("rollback");
        return null;
      }
      await this.deleteClientArtifacts(connection, clientId);
      await this.insertAudit(connection, audit);
      await connection.query("commit");
      return this.findManagedOidcClient(clientId);
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async findManagedOidcClient(
    clientId: string,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) return this.memoryManaged(clientId);
    const result = await pool.query(
      `select c.*, ar.revision_id as ar_revision_id, ar.revision_number as ar_revision_number,
         ar.review_status as ar_review_status, ar.redirect_uris as ar_redirect_uris,
         ar.post_logout_redirect_uris as ar_post_logout_redirect_uris,
         ar.scope_whitelist as ar_scope_whitelist, ar.rejection_reason as ar_rejection_reason,
         ar.created_at as ar_created_at, ar.updated_at as ar_updated_at, ar.version as ar_version,
         pr.revision_id as pr_revision_id, pr.revision_number as pr_revision_number,
         pr.review_status as pr_review_status, pr.redirect_uris as pr_redirect_uris,
         pr.post_logout_redirect_uris as pr_post_logout_redirect_uris,
         pr.scope_whitelist as pr_scope_whitelist, pr.rejection_reason as pr_rejection_reason,
         pr.created_at as pr_created_at, pr.updated_at as pr_updated_at, pr.version as pr_version
       from oidc_clients c
       left join oidc_client_revisions ar on ar.revision_id = c.active_revision_id
       left join lateral (
         select * from oidc_client_revisions r
         where c.lifecycle_status <> 'disabled'
           and r.client_id = c.client_id
           and r.review_status in ('draft', 'pending', 'rejected')
           and (ar.revision_number is null or r.revision_number > ar.revision_number)
         order by r.revision_number desc limit 1
       ) pr on true where c.client_id = $1`,
      [clientId],
    );
    const managed = this.mapManagedRow(result.rows[0]);
    if (!managed) return null;
    managed.secrets = await this.listSecrets(clientId);
    return managed;
  }

  async findOidcClient(
    clientId: string,
  ): Promise<ActiveOidcClientRecord | null> {
    const pool = this.poolProvider();
    const managed = pool
      ? this.mapManagedRow(
          (
            await pool.query(
              `select c.*, ar.revision_id as ar_revision_id,
                 ar.revision_number as ar_revision_number,
                 ar.review_status as ar_review_status,
                 ar.redirect_uris as ar_redirect_uris,
                 ar.post_logout_redirect_uris as ar_post_logout_redirect_uris,
                 ar.scope_whitelist as ar_scope_whitelist,
                 ar.rejection_reason as ar_rejection_reason,
                 ar.created_at as ar_created_at, ar.updated_at as ar_updated_at,
                 ar.version as ar_version
               from oidc_clients c
               join oidc_client_revisions ar on ar.revision_id = c.active_revision_id
               where c.client_id = $1 and c.lifecycle_status = 'active'`,
              [clientId],
            )
          ).rows[0],
        )
      : this.memoryManaged(clientId);
    if (
      !managed ||
      managed.client.lifecycleStatus !== "active" ||
      !managed.activeRevision
    )
      return null;
    const usableSecrets = pool
      ? await this.listUsableSecrets(clientId, pool)
      : managed.secrets.filter((secret) => this.isUsableSecret(secret));
    return this.toActive(managed.client, managed.activeRevision, usableSecrets);
  }

  async listActiveOidcClients(): Promise<ActiveOidcClientRecord[]> {
    const managed = await this.listManaged("c.lifecycle_status = 'active'", []);
    return managed.flatMap((entry) =>
      entry.activeRevision
        ? [
            this.toActive(
              entry.client,
              entry.activeRevision,
              entry.secrets.filter((secret) => this.isUsableSecret(secret)),
            ),
          ]
        : [],
    );
  }

  async listOidcClientsByProject(projectId: string) {
    return this.listManaged("c.project_id = $1", [projectId]);
  }

  async listOidcClients() {
    return this.listManaged("true", []);
  }

  async listPendingOidcClients() {
    return this.listManaged(
      "c.lifecycle_status <> 'disabled' and exists (select 1 from oidc_client_revisions r where r.client_id = c.client_id and r.review_status = 'pending')",
      [],
    );
  }

  async listOidcClientAuditLogs(
    clientId?: string,
  ): Promise<OidcClientAuditRecord[]> {
    const pool = this.poolProvider();
    if (!pool)
      return this.audits
        .filter((audit) => !clientId || audit.clientId === clientId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const result = clientId
      ? await pool.query(
          "select * from project_audit_logs where client_id = $1 order by created_at, id",
          [clientId],
        )
      : await pool.query(
          "select * from project_audit_logs where client_id is not null order by created_at, id",
        );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: Number(row["id"]),
      projectId: String(row["project_id"]),
      clientId: String(row["client_id"]),
      revisionId:
        row["revision_id"] == null ? undefined : Number(row["revision_id"]),
      revisionNumber:
        row["revision_number"] == null
          ? undefined
          : Number(row["revision_number"]),
      secretId: (row["secret_id"] as string | null) ?? undefined,
      actorSubjectId: (row["actor_subject_id"] as string | null) ?? null,
      action: row["action"] as OidcClientAuditRecord["action"],
      changedFields: row["changed_fields"] as string[],
      previousClientStatus:
        (row["previous_client_status"] as
          | OidcClientAuditRecord["previousClientStatus"]
          | null) ?? undefined,
      newClientStatus:
        (row["new_client_status"] as
          | OidcClientAuditRecord["newClientStatus"]
          | null) ?? undefined,
      previousRevisionStatus:
        (row["previous_revision_status"] as
          | OidcClientAuditRecord["previousRevisionStatus"]
          | null) ?? undefined,
      newRevisionStatus:
        (row["new_revision_status"] as
          | OidcClientAuditRecord["newRevisionStatus"]
          | null) ?? undefined,
      reason: (row["reason"] as string | null) ?? undefined,
      sourceIp: (row["source_ip"] as string | null) ?? undefined,
      createdAt: this.toIso(row["created_at"]),
    }));
  }

  private async listManaged(where: string, values: unknown[]) {
    const pool = this.poolProvider();
    if (!pool) {
      return [...this.clients.values()]
        .filter(
          (client) =>
            where === "true" ||
            (where.includes("project_id")
              ? client.projectId === values[0]
              : where.includes("lifecycle_status = 'active'")
                ? client.lifecycleStatus === "active"
                : client.lifecycleStatus !== "disabled" &&
                  this.proposedFor(client.clientId)?.status === "pending"),
        )
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) ||
            a.clientId.localeCompare(b.clientId),
        )
        .map((client) => this.memoryManaged(client.clientId)!);
    }
    const ids = await pool.query(
      `select c.client_id from oidc_clients c where ${where} order by c.updated_at desc, c.client_id`,
      values,
    );
    return Promise.all(
      ids.rows.map((row: Record<string, unknown>) =>
        this.findManagedOidcClient(String(row["client_id"])),
      ),
    ) as Promise<ManagedOidcClientRecord[]>;
  }

  private memoryManaged(clientId: string): ManagedOidcClientRecord | null {
    const client = this.clients.get(clientId);
    if (!client) return null;
    return {
      client,
      secrets: [...this.secrets.values()]
        .filter((secret) => secret.clientId === clientId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      activeRevision: client.activeRevisionId
        ? (this.revisions.get(client.activeRevisionId) ?? null)
        : null,
      proposedRevision: this.proposedFor(clientId),
    };
  }

  private proposedFor(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client || client.lifecycleStatus === "disabled") return null;
    const activeRevision = client?.activeRevisionId
      ? this.revisions.get(client.activeRevisionId)
      : undefined;
    return (
      [...this.revisions.values()]
        .filter(
          (revision) =>
            revision.clientId === clientId &&
            (revision.status === "draft" ||
              revision.status === "pending" ||
              revision.status === "rejected") &&
            (!activeRevision ||
              revision.revisionNumber > activeRevision.revisionNumber),
        )
        .sort((a, b) => b.revisionNumber - a.revisionNumber)[0] ?? null
    );
  }

  private async updatedResult(
    clientId: string,
  ): Promise<RevisionMutationResult> {
    const client = await this.findManagedOidcClient(clientId);
    if (!client) return { status: "version_conflict" };
    return { status: "updated", client };
  }

  private toActive(
    client: OidcClientRecord,
    revision: OidcClientRevisionRecord,
    secrets: OidcClientSecretRecord[],
  ): ActiveOidcClientRecord {
    const web = client.clientType === "web";
    return {
      ...client,
      activeRevisionId: revision.revisionId,
      activeRevision: revision,
      applicationType: "web",
      tokenEndpointAuthMethod: web ? "client_secret_basic" : "none",
      redirectUris: revision.redirectUris,
      postLogoutRedirectUris: revision.postLogoutRedirectUris,
      grantTypes: web
        ? ["authorization_code", "refresh_token"]
        : ["authorization_code"],
      responseTypes: ["code"],
      scopeWhitelist: revision.scopeWhitelist,
      requirePkce: true,
      allowRefreshTokenForPublicClient: false,
      clientSecretDigests: web
        ? secrets.map((secret) => secret.secretDigest)
        : [],
      autoConsent: client.autoConsent,
    };
  }

  private clientPart(client: ActiveOidcClientRecord): OidcClientRecord {
    return {
      clientId: client.clientId,
      projectId: client.projectId,
      displayName: client.displayName,
      description: client.description,
      createdBySubjectId: client.createdBySubjectId,
      clientType: client.clientType,
      autoConsent: client.autoConsent,
      lifecycleStatus: client.lifecycleStatus,
      activeRevisionId: client.activeRevisionId,
      authorizationGeneration: client.authorizationGeneration,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      version: client.version,
    };
  }

  private assignRevisionId(revision: OidcClientRevisionRecord) {
    if (revision.revisionId > 0) {
      this.nextRevisionId = Math.max(
        this.nextRevisionId,
        revision.revisionId + 1,
      );
      return revision;
    }
    return { ...revision, revisionId: this.nextRevisionId++ };
  }

  private pushRevisionAudits(
    audits: OidcClientAuditRecord[],
    revision: OidcClientRevisionRecord,
  ) {
    this.audits.push(
      ...audits.map((audit) => ({
        ...audit,
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
      })),
    );
  }

  private projectQuotaExceeded(
    client: OidcClientRecord,
    limits: ClientProjectLimits,
  ) {
    return (
      [...this.clients.values()].filter(
        (candidate) =>
          candidate.projectId === client.projectId &&
          candidate.lifecycleStatus !== "disabled",
      ).length >= limits.maxNonDisabledClients
    );
  }

  private subjectClientQuotaExceeded(
    subjectId: string | null,
    maxNonDisabledClients: number,
  ) {
    if (!subjectId) return false;
    return (
      [...this.clients.values()].filter(
        (candidate) =>
          this.clientQuotaSubjects.get(candidate.clientId) === subjectId &&
          candidate.lifecycleStatus !== "disabled",
      ).length >= maxNonDisabledClients
    );
  }

  private memoryPendingQuotaExceeded(
    projectId: string,
    subjectId: string | null,
    limits: ClientProjectLimits,
  ) {
    let projectPending = 0;
    let subjectPending = 0;
    for (const revision of this.revisions.values()) {
      if (revision.status !== "pending") continue;
      const client = this.clients.get(revision.clientId);
      if (!client || client.lifecycleStatus === "disabled") continue;
      if (client.projectId === projectId) projectPending += 1;
      if (
        subjectId &&
        this.clientQuotaSubjects.get(client.clientId) === subjectId
      )
        subjectPending += 1;
    }
    return (
      projectPending >= limits.maxPendingClients ||
      (!!subjectId && subjectPending >= limits.maxPendingClientsPerSubject)
    );
  }

  private async pendingQuotaExceeded(
    queryable: Queryable,
    projectId: string,
    subjectId: string | null,
    limits: ClientProjectLimits,
  ) {
    const result = await queryable.query(
      `select
         count(*) filter (where c.project_id = $1)::int as project_pending,
         count(*) filter (where p.created_by_subject_id = $2)::int as subject_pending
       from oidc_client_revisions r
       join oidc_clients c on c.client_id = r.client_id
       join projects p on p.project_id = c.project_id
       where c.lifecycle_status <> 'disabled' and r.review_status = 'pending'`,
      [projectId, subjectId],
    );
    return (
      Number(result.rows[0]?.["project_pending"] ?? 0) >=
        limits.maxPendingClients ||
      (subjectId !== null &&
        Number(result.rows[0]?.["subject_pending"] ?? 0) >=
          limits.maxPendingClientsPerSubject)
    );
  }

  private async authorizeProjectWrite(
    queryable: Queryable,
    authorization: ProjectWriteAuthorization,
    clientId?: string,
  ) {
    const projectResult = await queryable.query(
      `select p.*, pm.role
       from projects p
       left join project_members pm
         on pm.project_id = p.project_id and pm.subject_id = $2
       where p.project_id = $1
       for update of p`,
      [authorization.projectId, authorization.actor.subjectId],
    );
    const row = projectResult.rows[0] as Record<string, unknown> | undefined;
    const project = row
      ? {
          projectId: String(row["project_id"]),
          name: String(row["name"]),
          description: String(row["description"]),
          status: row["status"] as "active" | "archived",
          createdBySubjectId:
            (row["created_by_subject_id"] as string | null) ?? null,
          version: Number(row["version"]),
          createdAt: new Date(row["created_at"] as string | Date).toISOString(),
          updatedAt: new Date(row["updated_at"] as string | Date).toISOString(),
        }
      : null;
    assertProjectAccess(
      authorization.actor,
      project,
      (row?.["role"] as "owner" | "maintainer" | "viewer" | null) ?? null,
      authorization.action,
    );
    if (clientId) {
      const client = await queryable.query(
        "select project_id from oidc_clients where client_id = $1 for update",
        [clientId],
      );
      if (client.rows[0]?.["project_id"] !== authorization.projectId)
        throw new ClientManagementError(404, "not_found", "client not found");
    }
    return project!;
  }

  private async lockQuotaSubject(
    queryable: Queryable,
    createdBySubjectId: string | null,
  ) {
    if (!createdBySubjectId) return;
    await queryable.query("select pg_advisory_xact_lock(hashtext($1))", [
      `cqut-auth:oidc-client-creator:${createdBySubjectId}`,
    ]);
  }

  private insertClientSql() {
    return `insert into oidc_clients (client_id, project_id, display_name, description,
      created_by_subject_id, client_type, auto_consent, lifecycle_status, active_revision_id,
      authorization_generation, created_at, updated_at, version)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, $13)`;
  }

  private clientValues(client: OidcClientRecord) {
    return [
      client.clientId,
      client.projectId,
      client.displayName,
      client.description,
      client.createdBySubjectId,
      client.clientType,
      client.autoConsent,
      client.lifecycleStatus,
      client.activeRevisionId,
      client.authorizationGeneration,
      client.createdAt,
      client.updatedAt,
      client.version,
    ];
  }

  private async insertRevision(
    queryable: Queryable,
    revision: OidcClientRevisionRecord,
  ) {
    const result = await queryable.query(
      `insert into oidc_client_revisions (client_id, revision_number, review_status, redirect_uris,
        post_logout_redirect_uris, scope_whitelist, rejection_reason, created_at, updated_at, version)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::timestamptz, $9::timestamptz, $10)
       returning *`,
      [
        revision.clientId,
        revision.revisionNumber,
        revision.status,
        JSON.stringify(revision.redirectUris),
        JSON.stringify(revision.postLogoutRedirectUris),
        JSON.stringify(revision.scopeWhitelist),
        revision.rejectionReason ?? null,
        revision.createdAt,
        revision.updatedAt,
        revision.version,
      ],
    );
    return this.mapRevisionRow(result.rows[0])!;
  }

  private async insertSecret(
    queryable: Queryable,
    secret: OidcClientSecretRecord,
    useDatabaseTime = false,
  ) {
    const result = await queryable.query(
      `insert into oidc_client_secrets
       (secret_id, client_id, secret_digest, status, created_at, expires_at, revoked_at, version)
       values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6::timestamptz, $7::timestamptz, $8)
       returning *`,
      [
        secret.secretId,
        secret.clientId,
        secret.secretDigest,
        secret.status,
        useDatabaseTime ? null : secret.createdAt,
        secret.expiresAt,
        secret.revokedAt,
        secret.version,
      ],
    );
    return this.mapSecretRow(result.rows[0]);
  }

  private async listSecrets(clientId: string, queryable?: Queryable) {
    const executor = queryable ?? this.poolProvider();
    if (!executor) {
      return [...this.secrets.values()]
        .filter((secret) => secret.clientId === clientId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    const result = await executor.query(
      `select * from oidc_client_secrets
       where client_id = $1 order by created_at desc, secret_id`,
      [clientId],
    );
    return result.rows.map((row: Record<string, unknown>) =>
      this.mapSecretRow(row),
    );
  }

  private async listUsableSecrets(clientId: string, queryable: Queryable) {
    const result = await queryable.query(
      `select * from oidc_client_secrets
       where client_id = $1
         and (status = 'active' or (status = 'retiring' and expires_at > now()))
       order by created_at desc, secret_id`,
      [clientId],
    );
    return result.rows.map((row: Record<string, unknown>) =>
      this.mapSecretRow(row),
    );
  }

  private mapSecretRow(row: Record<string, unknown>): OidcClientSecretRecord {
    return {
      secretId: String(row["secret_id"]),
      clientId: String(row["client_id"]),
      secretDigest: String(row["secret_digest"]),
      status: row["status"] as OidcClientSecretRecord["status"],
      createdAt: this.toIso(row["created_at"]),
      expiresAt:
        row["expires_at"] == null ? null : this.toIso(row["expires_at"]),
      revokedAt:
        row["revoked_at"] == null ? null : this.toIso(row["revoked_at"]),
      version: Number(row["version"]),
    };
  }

  private isUsableSecret(
    secret: OidcClientSecretRecord,
    now = new Date().toISOString(),
  ) {
    return (
      secret.status === "active" ||
      (secret.status === "retiring" &&
        secret.expiresAt !== null &&
        secret.expiresAt > now)
    );
  }

  private usableMemorySecrets(clientId: string, now?: string) {
    return [...this.secrets.values()].filter(
      (secret) =>
        secret.clientId === clientId && this.isUsableSecret(secret, now),
    );
  }

  private replaceMemoryBootstrapSecrets(active: ActiveOidcClientRecord) {
    for (const [secretId, secret] of this.secrets.entries()) {
      if (secret.clientId === active.clientId) this.secrets.delete(secretId);
    }
    for (const [index, digest] of active.clientSecretDigests.entries()) {
      const secretId = `bootstrap:${active.clientId}:${index + 1}`;
      this.secrets.set(secretId, {
        secretId,
        clientId: active.clientId,
        secretDigest: digest,
        status: index === 0 ? "active" : "retiring",
        createdAt: active.createdAt,
        expiresAt: index === 0 ? null : active.updatedAt,
        revokedAt: null,
        version: 1,
      });
    }
  }

  private async deleteClientArtifacts(queryable: Queryable, clientId: string) {
    await queryable.query(
      `delete from oidc_artifacts
       where client_id_hash = $1
         and kind = any($2::text[])`,
      [
        this.clientIdHasher(clientId),
        ["AuthorizationCode", "AccessToken", "RefreshToken", "Grant"],
      ],
    );
  }

  private async upsertActive(
    queryable: Queryable,
    active: ActiveOidcClientRecord,
  ) {
    const base = { ...this.clientPart(active), activeRevisionId: null };
    await queryable.query(
      `${this.insertClientSql()} on conflict (client_id) do update set
       display_name = excluded.display_name,
       description = excluded.description, project_id = excluded.project_id,
       created_by_subject_id = excluded.created_by_subject_id,
       client_type = excluded.client_type, auto_consent = excluded.auto_consent, lifecycle_status = excluded.lifecycle_status,
       updated_at = excluded.updated_at, version = excluded.version`,
      this.clientValues(base),
    );
    const existing = await queryable.query(
      "select * from oidc_client_revisions where client_id = $1 and revision_number = $2",
      [active.clientId, active.activeRevision.revisionNumber],
    );
    const revision = existing.rows[0]
      ? this.mapRevisionRow(
          (
            await queryable.query(
              `update oidc_client_revisions set review_status = $3,
                 redirect_uris = $4::jsonb, post_logout_redirect_uris = $5::jsonb,
                 scope_whitelist = $6::jsonb, rejection_reason = $7,
                 updated_at = $8::timestamptz, version = $9
               where client_id = $1 and revision_number = $2 returning *`,
              [
                active.clientId,
                active.activeRevision.revisionNumber,
                active.activeRevision.status,
                JSON.stringify(active.activeRevision.redirectUris),
                JSON.stringify(active.activeRevision.postLogoutRedirectUris),
                JSON.stringify(active.activeRevision.scopeWhitelist),
                active.activeRevision.rejectionReason ?? null,
                active.activeRevision.updatedAt,
                active.activeRevision.version,
              ],
            )
          ).rows[0],
        )!
      : await this.insertRevision(queryable, active.activeRevision);
    await queryable.query(
      "update oidc_clients set active_revision_id = $2 where client_id = $1",
      [active.clientId, revision.revisionId],
    );
    await queryable.query(
      "delete from oidc_client_secrets where client_id = $1",
      [active.clientId],
    );
    for (const [index, digest] of active.clientSecretDigests.entries()) {
      await this.insertSecret(queryable, {
        secretId: `bootstrap:${active.clientId}:${index + 1}`,
        clientId: active.clientId,
        secretDigest: digest,
        status: index === 0 ? "active" : "retiring",
        createdAt: active.createdAt,
        expiresAt: index === 0 ? null : active.updatedAt,
        revokedAt: null,
        version: 1,
      });
    }
    return this.toActive(
      { ...base, activeRevisionId: revision.revisionId },
      revision,
      await this.listSecrets(active.clientId, queryable),
    );
  }

  private async insertAudit(
    queryable: Queryable,
    audit: OidcClientAuditRecord,
  ) {
    await queryable.query(
      `insert into project_audit_logs (project_id, client_id, revision_id, revision_number, secret_id, actor_subject_id,
        action, changed_fields, previous_client_status, new_client_status,
        previous_revision_status, new_revision_status, reason, source_ip, created_at)
       values (coalesce($1, (select project_id from oidc_clients where client_id = $2)), $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15::timestamptz)`,
      [
        audit.projectId ?? null,
        audit.clientId,
        audit.revisionId ?? null,
        audit.revisionNumber ?? null,
        audit.secretId ?? null,
        audit.actorSubjectId,
        audit.action,
        JSON.stringify(audit.changedFields),
        audit.previousClientStatus ?? null,
        audit.newClientStatus ?? null,
        audit.previousRevisionStatus ?? null,
        audit.newRevisionStatus ?? null,
        audit.reason ?? null,
        audit.sourceIp ?? null,
        audit.createdAt,
      ],
    );
  }

  private mapManagedRow(
    row: Record<string, unknown> | undefined,
  ): ManagedOidcClientRecord | null {
    if (!row) return null;
    return {
      client: this.mapClientRow(row)!,
      secrets: [],
      activeRevision:
        row["ar_revision_id"] == null
          ? null
          : this.mapRevisionPrefix(row, "ar_"),
      proposedRevision:
        row["pr_revision_id"] == null
          ? null
          : this.mapRevisionPrefix(row, "pr_"),
    };
  }

  private mapClientRow(
    row: Record<string, unknown> | undefined,
  ): OidcClientRecord | null {
    if (!row) return null;
    return {
      clientId: String(row["client_id"]),
      projectId: String(row["project_id"]),
      displayName: String(row["display_name"]),
      description: String(row["description"] ?? ""),
      createdBySubjectId:
        (row["created_by_subject_id"] as string | null) ?? null,
      clientType: row["client_type"] as OidcClientRecord["clientType"],
      autoConsent: Boolean(row["auto_consent"]),
      lifecycleStatus: row[
        "lifecycle_status"
      ] as OidcClientRecord["lifecycleStatus"],
      activeRevisionId:
        row["active_revision_id"] == null
          ? null
          : Number(row["active_revision_id"]),
      authorizationGeneration: Number(row["authorization_generation"]),
      createdAt: this.toIso(row["created_at"]),
      updatedAt: this.toIso(row["updated_at"]),
      version: Number(row["version"]),
    };
  }

  private mapRevisionRow(
    row: Record<string, unknown> | undefined,
  ): OidcClientRevisionRecord | null {
    if (!row) return null;
    return {
      revisionId: Number(row["revision_id"]),
      clientId: String(row["client_id"]),
      revisionNumber: Number(row["revision_number"]),
      status: row["review_status"] as ClientRevisionStatus,
      redirectUris: row["redirect_uris"] as string[],
      postLogoutRedirectUris: row["post_logout_redirect_uris"] as string[],
      scopeWhitelist: row[
        "scope_whitelist"
      ] as OidcClientRevisionRecord["scopeWhitelist"],
      rejectionReason: (row["rejection_reason"] as string | null) ?? undefined,
      createdAt: this.toIso(row["created_at"]),
      updatedAt: this.toIso(row["updated_at"]),
      version: Number(row["version"]),
    };
  }

  private mapRevisionPrefix(
    row: Record<string, unknown>,
    prefix: string,
  ): OidcClientRevisionRecord {
    return {
      revisionId: Number(row[`${prefix}revision_id`]),
      clientId: String(row["client_id"]),
      revisionNumber: Number(row[`${prefix}revision_number`]),
      status: row[`${prefix}review_status`] as ClientRevisionStatus,
      redirectUris: row[`${prefix}redirect_uris`] as string[],
      postLogoutRedirectUris: row[
        `${prefix}post_logout_redirect_uris`
      ] as string[],
      scopeWhitelist: row[
        `${prefix}scope_whitelist`
      ] as OidcClientRevisionRecord["scopeWhitelist"],
      rejectionReason:
        (row[`${prefix}rejection_reason`] as string | null) ?? undefined,
      createdAt: this.toIso(row[`${prefix}created_at`]),
      updatedAt: this.toIso(row[`${prefix}updated_at`]),
      version: Number(row[`${prefix}version`]),
    };
  }

  private toIso(value: unknown) {
    return value instanceof Date
      ? value.toISOString()
      : new Date(String(value)).toISOString();
  }
}

type ClientIdHasher = (clientId: string) => string;
type RevokeArtifacts = (clientId: string) => Promise<void>;
type MemoryProjectWrite = <T>(
  authorization: ProjectWriteAuthorization,
  clientProjectId: string,
  mutation: (project: ProjectRecord) => Promise<T>,
) => Promise<T>;

export class MemoryOidcClientRepository extends OidcClientRepositoryImpl {
  constructor(
    clientIdHasher?: ClientIdHasher,
    revokeArtifacts?: RevokeArtifacts,
    withProjectWrite?: MemoryProjectWrite,
  ) {
    super(() => undefined, clientIdHasher, revokeArtifacts, withProjectWrite);
  }
}

export class PostgresOidcClientRepository extends OidcClientRepositoryImpl {
  constructor(
    pool: Pool,
    clientIdHasher?: ClientIdHasher,
    revokeArtifacts?: RevokeArtifacts,
  ) {
    super(() => pool, clientIdHasher, revokeArtifacts);
  }
}
