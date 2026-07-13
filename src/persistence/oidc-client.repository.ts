import type { Pool, PoolClient } from "pg";
import type {
  ActiveOidcClientRecord,
  ClientRevisionStatus,
  ManagedOidcClientRecord,
  OidcClientAuditRecord,
  OidcClientRecord,
  OidcClientRepository,
  OidcClientRevisionRecord,
} from "./contracts.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export class OidcClientRepositoryImpl implements OidcClientRepository {
  private readonly clients = new Map<string, OidcClientRecord>();
  private readonly revisions = new Map<number, OidcClientRevisionRecord>();
  private readonly audits: OidcClientAuditRecord[] = [];
  private nextRevisionId = 1;

  constructor(private readonly poolProvider: () => Pool | undefined) {}

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
      return this.toActive(this.clients.get(active.clientId)!, revision);
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const result = await this.upsertActive(connection, active);
      await connection.query("commit");
      return result;
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
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
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      await connection.query(
        "select pg_advisory_xact_lock(hashtext('cqut-auth:oidc-client-initialize'))",
      );
      const count = await connection.query(
        "select count(*)::int as count from oidc_clients",
      );
      if (Number(count.rows[0]?.count ?? 0) > 0) {
        await connection.query("commit");
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
      await connection.query("commit");
      return { imported: true, count: clients.length };
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async createOidcClient(
    client: OidcClientRecord,
    revision: OidcClientRevisionRecord,
    audits: OidcClientAuditRecord[],
    ownerLimits?: { maxNonDisabledClients: number; maxPendingClients: number },
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      if (this.clients.has(client.clientId)) {
        throw new Error(`oidc client already exists: ${client.clientId}`);
      }
      if (ownerLimits && this.ownerQuotaExceeded(client, ownerLimits))
        return null;
      const assigned = this.assignRevisionId(revision);
      this.clients.set(client.clientId, client);
      this.revisions.set(assigned.revisionId, assigned);
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
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      if (ownerLimits && client.ownerSubjectId) {
        await this.lockOwner(connection, client.ownerSubjectId);
        const count = await connection.query(
          `select count(*) filter (where lifecycle_status <> 'disabled')::int as non_disabled
             from oidc_clients where owner_subject_id = $1`,
          [client.ownerSubjectId],
        );
        if (
          Number(count.rows[0]?.non_disabled ?? 0) >=
          ownerLimits.maxNonDisabledClients
        ) {
          await connection.query("rollback");
          return null;
        }
      }
      await connection.query(this.insertClientSql(), this.clientValues(client));
      const inserted = await this.insertRevision(connection, revision);
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
      await connection.query("commit");
      return this.findManagedOidcClient(client.clientId);
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateOidcClientMetadata(
    clientId: string,
    patch: Pick<OidcClientRecord, "displayName" | "description" | "updatedAt">,
    expectedVersion: number,
    audit: OidcClientAuditRecord,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const current = this.clients.get(clientId);
      if (!current || current.version !== expectedVersion) return null;
      this.clients.set(clientId, {
        ...current,
        ...patch,
        version: current.version + 1,
      });
      this.audits.push(audit);
      return this.memoryManaged(clientId);
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
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
        await connection.query("rollback");
        return null;
      }
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

  async saveOidcClientRevision(
    clientId: string,
    revision: OidcClientRevisionRecord,
    expectedRevisionId: number | null,
    expectedRevisionVersion: number | null,
    audits: OidcClientAuditRecord[],
    maxPendingClients?: number,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const managed = this.memoryManaged(clientId);
      if (!managed) return null;
      if (revision.status === "pending" && maxPendingClients !== undefined) {
        const owner = managed.client.ownerSubjectId;
        const pending = [...this.revisions.values()].filter(
          (candidate) =>
            candidate.status === "pending" &&
            this.clients.get(candidate.clientId)?.ownerSubjectId === owner,
        ).length;
        if (pending >= maxPendingClients) return null;
      }
      if (expectedRevisionId === null) {
        if (
          managed.proposedRevision?.status === "draft" ||
          managed.proposedRevision?.status === "pending"
        )
          return null;
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
          return null;
        const next = {
          ...revision,
          revisionId: current.revisionId,
          revisionNumber: current.revisionNumber,
          version: current.version + 1,
        };
        this.revisions.set(current.revisionId, next);
        this.pushRevisionAudits(audits, next);
      }
      return this.memoryManaged(clientId);
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const clientResult = await connection.query(
        "select owner_subject_id from oidc_clients where client_id = $1 for update",
        [clientId],
      );
      if (revision.status === "pending" && maxPendingClients !== undefined) {
        const owner = clientResult.rows[0]?.["owner_subject_id"] as
          | string
          | null;
        if (owner) {
          await this.lockOwner(connection, owner);
          const count = await connection.query(
            `select count(*)::int as count from oidc_client_revisions r join oidc_clients c on c.client_id = r.client_id where c.owner_subject_id = $1 and r.review_status = 'pending'`,
            [owner],
          );
          if (Number(count.rows[0]?.count ?? 0) >= maxPendingClients) {
            await connection.query("rollback");
            return null;
          }
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
          return null;
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
          return null;
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
      return this.findManagedOidcClient(clientId);
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
    maxPendingClients?: number,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const current = this.revisions.get(revisionId);
      if (
        !current ||
        current.clientId !== clientId ||
        current.version !== expectedVersion
      )
        return null;
      if (nextStatus === "pending" && maxPendingClients !== undefined) {
        const owner = this.clients.get(clientId)?.ownerSubjectId;
        const pending = [...this.revisions.values()].filter(
          (revision) =>
            revision.status === "pending" &&
            this.clients.get(revision.clientId)?.ownerSubjectId === owner,
        ).length;
        if (pending >= maxPendingClients) return null;
      }
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
      return this.memoryManaged(clientId);
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      if (nextStatus === "pending" && maxPendingClients !== undefined) {
        const client = await connection.query(
          "select owner_subject_id from oidc_clients where client_id = $1",
          [clientId],
        );
        const owner = client.rows[0]?.["owner_subject_id"] as string | null;
        if (owner) {
          await this.lockOwner(connection, owner);
          const count = await connection.query(
            `select count(*)::int as count from oidc_client_revisions r
             join oidc_clients c on c.client_id = r.client_id
             where c.owner_subject_id = $1 and r.review_status = 'pending'`,
            [owner],
          );
          if (Number(count.rows[0]?.count ?? 0) >= maxPendingClients) {
            await connection.query("rollback");
            return null;
          }
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
        return null;
      }
      const revision = this.mapRevisionRow(result.rows[0])!;
      await this.insertAudit(connection, {
        ...audit,
        revisionId,
        revisionNumber: revision.revisionNumber,
      });
      await connection.query("commit");
      return this.findManagedOidcClient(clientId);
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
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const client = this.clients.get(clientId);
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
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const clientResult = await connection.query(
        "select * from oidc_clients where client_id = $1 for update",
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
    audit: OidcClientAuditRecord,
  ): Promise<ManagedOidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const client = this.clients.get(clientId);
      if (!client || client.version !== expectedVersion) return null;
      this.clients.set(clientId, {
        ...client,
        lifecycleStatus: "disabled",
        updatedAt,
        version: client.version + 1,
      });
      this.audits.push(audit);
      return this.memoryManaged(clientId);
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const result = await connection.query(
        `update oidc_clients set lifecycle_status = 'disabled', updated_at = $3::timestamptz,
           version = version + 1 where client_id = $1 and version = $2`,
        [clientId, expectedVersion, updatedAt],
      );
      if (result.rowCount !== 1) {
        await connection.query("rollback");
        return null;
      }
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
         where r.client_id = c.client_id and r.review_status <> 'approved'
         order by r.revision_number desc limit 1
       ) pr on true where c.client_id = $1`,
      [clientId],
    );
    return this.mapManagedRow(result.rows[0]);
  }

  async findOidcClient(
    clientId: string,
  ): Promise<ActiveOidcClientRecord | null> {
    const managed = await this.findManagedOidcClient(clientId);
    if (
      !managed ||
      managed.client.lifecycleStatus !== "active" ||
      !managed.activeRevision
    )
      return null;
    return this.toActive(managed.client, managed.activeRevision);
  }

  async listActiveOidcClients(): Promise<ActiveOidcClientRecord[]> {
    const managed = await this.listManaged("c.lifecycle_status = 'active'", []);
    return managed.flatMap((entry) =>
      entry.activeRevision
        ? [this.toActive(entry.client, entry.activeRevision)]
        : [],
    );
  }

  async listOidcClientsByOwner(ownerSubjectId: string) {
    return this.listManaged("c.owner_subject_id = $1", [ownerSubjectId]);
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
          "select * from oidc_client_audit_logs where client_id = $1 order by created_at, id",
          [clientId],
        )
      : await pool.query(
          "select * from oidc_client_audit_logs order by created_at, id",
        );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: Number(row["id"]),
      clientId: String(row["client_id"]),
      revisionId:
        row["revision_id"] == null ? undefined : Number(row["revision_id"]),
      revisionNumber:
        row["revision_number"] == null
          ? undefined
          : Number(row["revision_number"]),
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
            (where.includes("owner_subject_id")
              ? client.ownerSubjectId === values[0]
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
      activeRevision: client.activeRevisionId
        ? (this.revisions.get(client.activeRevisionId) ?? null)
        : null,
      proposedRevision: this.proposedFor(clientId),
    };
  }

  private proposedFor(clientId: string) {
    return (
      [...this.revisions.values()]
        .filter(
          (revision) =>
            revision.clientId === clientId && revision.status !== "approved",
        )
        .sort((a, b) => b.revisionNumber - a.revisionNumber)[0] ?? null
    );
  }

  private toActive(
    client: OidcClientRecord,
    revision: OidcClientRevisionRecord,
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
      autoConsent: client.autoConsent,
    };
  }

  private clientPart(client: ActiveOidcClientRecord): OidcClientRecord {
    return {
      clientId: client.clientId,
      clientSecretDigest: client.clientSecretDigest,
      displayName: client.displayName,
      description: client.description,
      ownerSubjectId: client.ownerSubjectId,
      clientType: client.clientType,
      autoConsent: client.autoConsent,
      lifecycleStatus: client.lifecycleStatus,
      activeRevisionId: client.activeRevisionId,
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

  private ownerQuotaExceeded(
    client: OidcClientRecord,
    limits: { maxNonDisabledClients: number; maxPendingClients: number },
  ) {
    return (
      [...this.clients.values()].filter(
        (candidate) =>
          candidate.ownerSubjectId === client.ownerSubjectId &&
          candidate.lifecycleStatus !== "disabled",
      ).length >= limits.maxNonDisabledClients
    );
  }

  private async lockOwner(queryable: Queryable, ownerSubjectId: string) {
    await queryable.query("select pg_advisory_xact_lock(hashtext($1))", [
      `cqut-auth:oidc-client-owner:${ownerSubjectId}`,
    ]);
  }

  private insertClientSql() {
    return `insert into oidc_clients (client_id, client_secret_hash, display_name, description,
      owner_subject_id, client_type, auto_consent, lifecycle_status, active_revision_id, created_at, updated_at, version)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12)`;
  }

  private clientValues(client: OidcClientRecord) {
    return [
      client.clientId,
      client.clientSecretDigest ?? null,
      client.displayName,
      client.description,
      client.ownerSubjectId,
      client.clientType,
      client.autoConsent,
      client.lifecycleStatus,
      client.activeRevisionId,
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

  private async upsertActive(
    queryable: Queryable,
    active: ActiveOidcClientRecord,
  ) {
    const base = { ...this.clientPart(active), activeRevisionId: null };
    await queryable.query(
      `${this.insertClientSql()} on conflict (client_id) do update set
       client_secret_hash = excluded.client_secret_hash, display_name = excluded.display_name,
       description = excluded.description, owner_subject_id = excluded.owner_subject_id,
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
    return this.toActive(
      { ...base, activeRevisionId: revision.revisionId },
      revision,
    );
  }

  private async insertAudit(
    queryable: Queryable,
    audit: OidcClientAuditRecord,
  ) {
    await queryable.query(
      `insert into oidc_client_audit_logs (client_id, revision_id, revision_number, actor_subject_id,
        action, changed_fields, previous_client_status, new_client_status,
        previous_revision_status, new_revision_status, reason, source_ip, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::timestamptz)`,
      [
        audit.clientId,
        audit.revisionId ?? null,
        audit.revisionNumber ?? null,
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
      clientSecretDigest:
        (row["client_secret_hash"] as string | null) ?? undefined,
      displayName: String(row["display_name"]),
      description: String(row["description"] ?? ""),
      ownerSubjectId: (row["owner_subject_id"] as string | null) ?? null,
      clientType: row["client_type"] as OidcClientRecord["clientType"],
      autoConsent: Boolean(row["auto_consent"]),
      lifecycleStatus: row[
        "lifecycle_status"
      ] as OidcClientRecord["lifecycleStatus"],
      activeRevisionId:
        row["active_revision_id"] == null
          ? null
          : Number(row["active_revision_id"]),
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
