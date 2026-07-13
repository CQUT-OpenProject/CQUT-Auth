import type { Pool, PoolClient } from "pg";
import type {
  OidcClientAuditRecord,
  OidcClientRecord,
  OidcClientRepository,
} from "./contracts.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export class OidcClientRepositoryImpl implements OidcClientRepository {
  private readonly clients = new Map<string, OidcClientRecord>();
  private readonly audits: OidcClientAuditRecord[] = [];

  constructor(private readonly poolProvider: () => Pool | undefined) {}

  async upsertOidcClient(client: OidcClientRecord): Promise<OidcClientRecord> {
    const pool = this.poolProvider();
    if (!pool) {
      this.clients.set(client.clientId, client);
      return client;
    }
    await pool.query(
      `${this.insertSql()}
      on conflict (client_id) do update set
        client_secret_hash = excluded.client_secret_hash,
        display_name = excluded.display_name,
        description = excluded.description,
        owner_subject_id = excluded.owner_subject_id,
        application_type = excluded.application_type,
        token_endpoint_auth_method = excluded.token_endpoint_auth_method,
        redirect_uris = excluded.redirect_uris,
        post_logout_redirect_uris = excluded.post_logout_redirect_uris,
        grant_types = excluded.grant_types,
        response_types = excluded.response_types,
        scope_whitelist = excluded.scope_whitelist,
        require_pkce = excluded.require_pkce,
        allow_refresh_token_for_public_client = excluded.allow_refresh_token_for_public_client,
        auto_consent = excluded.auto_consent,
        status = excluded.status,
        rejection_reason = excluded.rejection_reason,
        updated_at = excluded.updated_at,
        version = excluded.version`,
      this.clientValues(client),
    );
    return client;
  }

  async countOidcClients(): Promise<number> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.clients.size;
    }
    const result = await pool.query(
      "select count(*)::int as count from oidc_clients",
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async initializeOidcClientsIfEmpty(
    clients: OidcClientRecord[],
    audits: OidcClientAuditRecord[],
  ): Promise<{ imported: boolean; count: number }> {
    const pool = this.poolProvider();
    if (!pool) {
      if (this.clients.size > 0) {
        return { imported: false, count: 0 };
      }
      for (const client of clients) {
        this.clients.set(client.clientId, client);
      }
      this.audits.push(...audits);
      return { imported: true, count: clients.length };
    }

    const connection = await pool.connect();
    try {
      await connection.query("begin");
      await connection.query(
        "select pg_advisory_xact_lock(hashtext('cqut-auth:oidc-client-initialize'))",
      );
      const countResult = await connection.query(
        "select count(*)::int as count from oidc_clients",
      );
      if (Number(countResult.rows[0]?.count ?? 0) > 0) {
        await connection.query("commit");
        return { imported: false, count: 0 };
      }
      for (const client of clients) {
        await connection.query(this.insertSql(), this.clientValues(client));
      }
      for (const audit of audits) {
        await this.insertAudit(connection, audit);
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
    audits: OidcClientAuditRecord[],
    ownerLimits?: {
      maxNonDisabledClients: number;
      maxPendingClients: number;
    },
  ): Promise<OidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      if (this.clients.has(client.clientId)) {
        throw new Error(`oidc client already exists: ${client.clientId}`);
      }
      if (ownerLimits && this.ownerQuotaExceeded(client, ownerLimits)) {
        return null;
      }
      this.clients.set(client.clientId, client);
      this.audits.push(...audits);
      return client;
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      if (ownerLimits && client.ownerSubjectId) {
        await connection.query("select pg_advisory_xact_lock(hashtext($1))", [
          `cqut-auth:oidc-client-owner:${client.ownerSubjectId}`,
        ]);
        const count = await connection.query(
          `select
             count(*) filter (where status <> 'disabled')::int as non_disabled,
             count(*) filter (where status = 'pending')::int as pending
           from oidc_clients where owner_subject_id = $1`,
          [client.ownerSubjectId],
        );
        if (
          Number(count.rows[0]?.non_disabled ?? 0) >=
            ownerLimits.maxNonDisabledClients ||
          Number(count.rows[0]?.pending ?? 0) >= ownerLimits.maxPendingClients
        ) {
          await connection.query("rollback");
          return null;
        }
      }
      await connection.query(this.insertSql(), this.clientValues(client));
      for (const audit of audits) {
        await this.insertAudit(connection, audit);
      }
      await connection.query("commit");
      return client;
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateOidcClient(
    client: OidcClientRecord,
    expectedVersion: number,
    audit: OidcClientAuditRecord,
  ): Promise<OidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const current = this.clients.get(client.clientId);
      if (!current || current.version !== expectedVersion) {
        return null;
      }
      this.clients.set(client.clientId, client);
      this.audits.push(audit);
      return client;
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const result = await connection.query(
        `update oidc_clients set
          display_name = $3,
          description = $4,
          application_type = $5,
          token_endpoint_auth_method = $6,
          redirect_uris = $7::jsonb,
          post_logout_redirect_uris = $8::jsonb,
          grant_types = $9::jsonb,
          response_types = $10::jsonb,
          scope_whitelist = $11::jsonb,
          require_pkce = $12,
          allow_refresh_token_for_public_client = $13,
          auto_consent = $14,
          status = $15,
          rejection_reason = $16,
          updated_at = $17::timestamptz,
          version = $18
        where client_id = $1 and version = $2
        returning *`,
        [
          client.clientId,
          expectedVersion,
          client.displayName,
          client.description,
          client.applicationType,
          client.tokenEndpointAuthMethod,
          JSON.stringify(client.redirectUris),
          JSON.stringify(client.postLogoutRedirectUris),
          JSON.stringify(client.grantTypes),
          JSON.stringify(client.responseTypes),
          JSON.stringify(client.scopeWhitelist),
          client.requirePkce,
          client.allowRefreshTokenForPublicClient,
          client.autoConsent,
          client.status,
          client.rejectionReason ?? null,
          client.updatedAt,
          client.version,
        ],
      );
      if (!result.rows[0]) {
        await connection.query("rollback");
        return null;
      }
      await this.insertAudit(connection, audit);
      await connection.query("commit");
      return this.mapClientRow(result.rows[0]);
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async findOidcClient(clientId: string): Promise<OidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.clients.get(clientId) ?? null;
    }
    const result = await pool.query(
      "select * from oidc_clients where client_id = $1 limit 1",
      [clientId],
    );
    return this.mapClientRow(result.rows[0]);
  }

  async listActiveOidcClients(): Promise<OidcClientRecord[]> {
    return this.listWhere("status = 'active'", []);
  }

  async listOidcClientsByOwner(
    ownerSubjectId: string,
  ): Promise<OidcClientRecord[]> {
    const pool = this.poolProvider();
    if (!pool) {
      return [...this.clients.values()]
        .filter((client) => client.ownerSubjectId === ownerSubjectId)
        .sort(this.sortClients);
    }
    return this.listWhere("owner_subject_id = $1", [ownerSubjectId]);
  }

  async listOidcClients(): Promise<OidcClientRecord[]> {
    return this.listWhere("true", []);
  }

  async listPendingOidcClients(): Promise<OidcClientRecord[]> {
    return this.listWhere("status = 'pending'", []);
  }

  async listOidcClientAuditLogs(
    clientId?: string,
  ): Promise<OidcClientAuditRecord[]> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.audits
        .filter((audit) => !clientId || audit.clientId === clientId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    const result = clientId
      ? await pool.query(
          "select * from oidc_client_audit_logs where client_id = $1 order by created_at asc, id asc",
          [clientId],
        )
      : await pool.query(
          "select * from oidc_client_audit_logs order by created_at asc, id asc",
        );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: Number(row["id"]),
      clientId: String(row["client_id"]),
      actorSubjectId: (row["actor_subject_id"] as string | null) ?? null,
      action: row["action"] as OidcClientAuditRecord["action"],
      changedFields: row["changed_fields"] as string[],
      previousStatus:
        (row["previous_status"] as OidcClientRecord["status"] | null) ??
        undefined,
      newStatus:
        (row["new_status"] as OidcClientRecord["status"] | null) ?? undefined,
      reason: (row["reason"] as string | null) ?? undefined,
      sourceIp: (row["source_ip"] as string | null) ?? undefined,
      createdAt: this.toIso(row["created_at"]),
    }));
  }

  private async listWhere(where: string, values: unknown[]) {
    const pool = this.poolProvider();
    if (!pool) {
      const clients = [...this.clients.values()];
      if (where === "status = 'active'") {
        return clients
          .filter((client) => client.status === "active")
          .sort(this.sortClients);
      }
      if (where === "status = 'pending'") {
        return clients
          .filter((client) => client.status === "pending")
          .sort(this.sortClients);
      }
      return clients.sort(this.sortClients);
    }
    const result = await pool.query(
      `select * from oidc_clients where ${where} order by updated_at desc, client_id asc`,
      values,
    );
    return result.rows.map((row: Record<string, unknown>) =>
      this.mapClientRow(row),
    ) as OidcClientRecord[];
  }

  private readonly sortClients = (
    left: OidcClientRecord,
    right: OidcClientRecord,
  ) =>
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.clientId.localeCompare(right.clientId);

  private insertSql() {
    return `insert into oidc_clients (
      client_id, client_secret_hash, display_name, description, owner_subject_id,
      application_type, token_endpoint_auth_method, redirect_uris, post_logout_redirect_uris,
      grant_types, response_types, scope_whitelist, require_pkce,
      allow_refresh_token_for_public_client, auto_consent, status, rejection_reason,
      created_at, updated_at, version
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
      $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17,
      $18::timestamptz, $19::timestamptz, $20
    )`;
  }

  private clientValues(client: OidcClientRecord) {
    return [
      client.clientId,
      client.clientSecretDigest ?? null,
      client.displayName,
      client.description,
      client.ownerSubjectId,
      client.applicationType,
      client.tokenEndpointAuthMethod,
      JSON.stringify(client.redirectUris),
      JSON.stringify(client.postLogoutRedirectUris),
      JSON.stringify(client.grantTypes),
      JSON.stringify(client.responseTypes),
      JSON.stringify(client.scopeWhitelist),
      client.requirePkce,
      client.allowRefreshTokenForPublicClient,
      client.autoConsent,
      client.status,
      client.rejectionReason ?? null,
      client.createdAt,
      client.updatedAt,
      client.version,
    ];
  }

  private async insertAudit(
    queryable: Queryable,
    audit: OidcClientAuditRecord,
  ) {
    await queryable.query(
      `insert into oidc_client_audit_logs (
        client_id, actor_subject_id, action, changed_fields, previous_status,
        new_status, reason, source_ip, created_at
      ) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::timestamptz)`,
      [
        audit.clientId,
        audit.actorSubjectId,
        audit.action,
        JSON.stringify(audit.changedFields),
        audit.previousStatus ?? null,
        audit.newStatus ?? null,
        audit.reason ?? null,
        audit.sourceIp ?? null,
        audit.createdAt,
      ],
    );
  }

  private mapClientRow(
    row: Record<string, unknown> | undefined,
  ): OidcClientRecord | null {
    if (!row) {
      return null;
    }
    return {
      clientId: String(row["client_id"]),
      clientSecretDigest:
        (row["client_secret_hash"] as string | null) ?? undefined,
      displayName: String(row["display_name"]),
      description: String(row["description"] ?? ""),
      ownerSubjectId: (row["owner_subject_id"] as string | null) ?? null,
      applicationType: "web",
      tokenEndpointAuthMethod: row[
        "token_endpoint_auth_method"
      ] as OidcClientRecord["tokenEndpointAuthMethod"],
      redirectUris: row["redirect_uris"] as string[],
      postLogoutRedirectUris: row["post_logout_redirect_uris"] as string[],
      grantTypes: row["grant_types"] as string[],
      responseTypes: row["response_types"] as string[],
      scopeWhitelist: row[
        "scope_whitelist"
      ] as OidcClientRecord["scopeWhitelist"],
      requirePkce: Boolean(row["require_pkce"]),
      allowRefreshTokenForPublicClient: Boolean(
        row["allow_refresh_token_for_public_client"],
      ),
      autoConsent: Boolean(row["auto_consent"]),
      status: row["status"] as OidcClientRecord["status"],
      rejectionReason: (row["rejection_reason"] as string | null) ?? undefined,
      createdAt: this.toIso(row["created_at"]),
      updatedAt: this.toIso(row["updated_at"]),
      version: Number(row["version"]),
    };
  }

  private toIso(value: unknown) {
    return value instanceof Date
      ? value.toISOString()
      : new Date(String(value)).toISOString();
  }

  private ownerQuotaExceeded(
    client: OidcClientRecord,
    limits: { maxNonDisabledClients: number; maxPendingClients: number },
  ) {
    const owned = [...this.clients.values()].filter(
      (candidate) => candidate.ownerSubjectId === client.ownerSubjectId,
    );
    return (
      owned.filter((candidate) => candidate.status !== "disabled").length >=
        limits.maxNonDisabledClients ||
      owned.filter((candidate) => candidate.status === "pending").length >=
        limits.maxPendingClients
    );
  }
}
