import type { Pool } from "pg";
import type { OidcClientRecord, OidcClientRepository } from "./contracts.js";

export class OidcClientRepositoryImpl implements OidcClientRepository {
  private readonly clients = new Map<string, OidcClientRecord>();

  constructor(private readonly poolProvider: () => Pool | undefined) {}

  async upsertOidcClient(client: OidcClientRecord): Promise<OidcClientRecord> {
    const pool = this.poolProvider();
    if (!pool) {
      this.clients.set(client.clientId, client);
      return client;
    }
    await pool.query(
      `
      insert into oidc_clients (
        client_id,
        client_secret_hash,
        application_type,
        token_endpoint_auth_method,
        redirect_uris,
        post_logout_redirect_uris,
        grant_types,
        response_types,
        scope_whitelist,
        require_pkce,
        status,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12::timestamptz, $13::timestamptz)
      on conflict (client_id) do update
      set client_secret_hash = excluded.client_secret_hash,
          application_type = excluded.application_type,
          token_endpoint_auth_method = excluded.token_endpoint_auth_method,
          redirect_uris = excluded.redirect_uris,
          post_logout_redirect_uris = excluded.post_logout_redirect_uris,
          grant_types = excluded.grant_types,
          response_types = excluded.response_types,
          scope_whitelist = excluded.scope_whitelist,
          require_pkce = excluded.require_pkce,
          status = excluded.status,
          updated_at = excluded.updated_at
      `,
      [
        client.clientId,
        client.clientSecretHash ?? null,
        client.applicationType,
        client.tokenEndpointAuthMethod,
        JSON.stringify(client.redirectUris),
        JSON.stringify(client.postLogoutRedirectUris),
        JSON.stringify(client.grantTypes),
        JSON.stringify(client.responseTypes),
        JSON.stringify(client.scopeWhitelist),
        client.requirePkce,
        client.status,
        client.createdAt,
        client.updatedAt
      ]
    );
    return client;
  }

  async findOidcClient(clientId: string): Promise<OidcClientRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.clients.get(clientId) ?? null;
    }
    const result = await pool.query("select * from oidc_clients where client_id = $1 limit 1", [clientId]);
    return this.mapClientRow(result.rows[0]);
  }

  async listActiveOidcClients(): Promise<OidcClientRecord[]> {
    const pool = this.poolProvider();
    if (!pool) {
      return [...this.clients.values()].filter((client) => client.status === "active");
    }
    const result = await pool.query("select * from oidc_clients where status = 'active' order by client_id asc");
    return result.rows
      .map((row: Record<string, unknown>) => this.mapClientRow(row))
      .filter(Boolean) as OidcClientRecord[];
  }

  private mapClientRow(row: Record<string, unknown> | undefined): OidcClientRecord | null {
    if (!row) {
      return null;
    }
    return {
      clientId: String(row["client_id"]),
      clientSecretHash: (row["client_secret_hash"] as string | null) ?? undefined,
      applicationType: row["application_type"] as OidcClientRecord["applicationType"],
      tokenEndpointAuthMethod: row["token_endpoint_auth_method"] as OidcClientRecord["tokenEndpointAuthMethod"],
      redirectUris: row["redirect_uris"] as string[],
      postLogoutRedirectUris: row["post_logout_redirect_uris"] as string[],
      grantTypes: row["grant_types"] as string[],
      responseTypes: row["response_types"] as string[],
      scopeWhitelist: row["scope_whitelist"] as OidcClientRecord["scopeWhitelist"],
      requirePkce: Boolean(row["require_pkce"]),
      status: row["status"] as OidcClientRecord["status"],
      createdAt: (row["created_at"] as Date).toISOString(),
      updatedAt: (row["updated_at"] as Date).toISOString()
    };
  }
}
