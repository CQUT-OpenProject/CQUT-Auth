import type {
  AuthenticatedPrincipal,
  IdentityStore,
  SubjectIdentityRecord,
  SubjectProfileRecord,
  SubjectRecord
} from "@cqut/identity-core";
import type { OidcScope } from "@cqut/shared";
import { Pool } from "pg";
import type { OidcOpConfig } from "../config.js";
import { decryptJson, encryptJson } from "../crypto.js";

export type OidcClientRecord = {
  clientId: string;
  clientSecretHash: string | undefined;
  applicationType: "web" | "native" | "service";
  tokenEndpointAuthMethod: "client_secret_basic" | "none";
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scopeWhitelist: OidcScope[];
  requirePkce: boolean;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

type ArtifactRecord = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  expiresAt: string | undefined;
  consumedAt: string | undefined;
  grantId: string | undefined;
  uid: string | undefined;
  userCode: string | undefined;
  clientId: string | undefined;
  subjectId: string | undefined;
  createdAt: string;
};

export type PendingInteractionLogin = {
  principal: AuthenticatedPrincipal;
  authTime: number;
};

export type OidcSigningKeyRecord = {
  kid: string;
  alg: string;
  use: string;
  publicJwk: JsonWebKey;
  privateJwkCiphertext: string;
  status: "active" | "retiring" | "retired";
  createdAt: string;
  activatedAt?: string | undefined;
  retiredAt?: string | undefined;
};

export class OidcStore implements IdentityStore {
  private readonly logger = console;
  private readonly subjects = new Map<string, SubjectRecord>();
  private readonly identities = new Map<string, SubjectIdentityRecord>();
  private readonly profiles = new Map<string, SubjectProfileRecord>();
  private readonly clients = new Map<string, OidcClientRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly signingKeys = new Map<string, OidcSigningKeyRecord>();
  private pool: Pool | undefined;

  constructor(private readonly config: OidcOpConfig) {}

  async init() {
    if (!this.config.databaseUrl) {
      if (this.config.allowInMemoryStore) {
        this.logger.warn("DATABASE_URL not configured for oidc-op, using in-memory store");
        return;
      }
      throw new Error("DATABASE_URL is required for oidc-op");
    }

    try {
      this.pool = new Pool({
        connectionString: this.config.databaseUrl
      });
      await this.pool.query("select 1");
      await this.ensureSchema();
    } catch (error) {
      await this.pool?.end().catch(() => undefined);
      this.pool = undefined;
      if (!this.config.allowInMemoryStore) {
        throw error;
      }
      this.logger.warn(
        `database unavailable for oidc-op, using in-memory store: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  async close() {
    await this.pool?.end();
  }

  hasDatabase() {
    return !!this.pool;
  }

  async checkReadiness() {
    if (!this.pool) {
      return this.config.allowInMemoryStore;
    }
    try {
      await this.pool.query("select 1");
      return true;
    } catch {
      return false;
    }
  }

  private async ensureSchema() {
    if (!this.pool) {
      return;
    }
    await this.pool.query(`
      create table if not exists subjects (
        subject_id text primary key,
        status text not null default 'active',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      create table if not exists subject_identities (
        id bigserial primary key,
        subject_id text not null references subjects(subject_id),
        provider text not null,
        school_uid text not null,
        identity_key text not null,
        current_student_status text,
        school text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique(provider, identity_key)
      );
    `);
    await this.pool.query(`
      create table if not exists subject_profiles (
        subject_id text primary key references subjects(subject_id),
        preferred_username text,
        display_name text,
        email text,
        email_verified boolean not null default false,
        updated_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      create table if not exists oidc_clients (
        client_id text primary key,
        client_secret_hash text,
        application_type text not null,
        token_endpoint_auth_method text not null,
        redirect_uris jsonb not null,
        post_logout_redirect_uris jsonb not null default '[]'::jsonb,
        grant_types jsonb not null,
        response_types jsonb not null,
        scope_whitelist jsonb not null,
        require_pkce boolean not null default true,
        status text not null default 'active',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      create table if not exists oidc_artifacts (
        id text primary key,
        kind text not null,
        grant_id text,
        uid text,
        user_code text,
        client_id text,
        subject_id text,
        payload jsonb not null,
        expires_at timestamptz,
        consumed_at timestamptz,
        created_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_kind_expires_at
      on oidc_artifacts (kind, expires_at);
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_uid
      on oidc_artifacts (uid);
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_user_code
      on oidc_artifacts (user_code);
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_grant_id
      on oidc_artifacts (grant_id);
    `);
    await this.pool.query(`
      create table if not exists oidc_signing_keys (
        kid text primary key,
        alg text not null,
        use text not null default 'sig',
        public_jwk jsonb not null,
        private_jwk_ciphertext text not null,
        status text not null,
        created_at timestamptz not null default now(),
        activated_at timestamptz,
        retired_at timestamptz
      );
    `);
  }

  private identityMapKey(provider: string, identityKey: string) {
    return `${provider}:${identityKey}`;
  }

  async findSubject(subjectId: string): Promise<SubjectRecord | null> {
    if (!this.pool) {
      return this.subjects.get(subjectId) ?? null;
    }
    const result = await this.pool.query("select * from subjects where subject_id = $1 limit 1", [subjectId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      subjectId: row.subject_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  }

  async findIdentity(provider: string, identityKey: string): Promise<SubjectIdentityRecord | null> {
    if (!this.pool) {
      return this.identities.get(this.identityMapKey(provider, identityKey)) ?? null;
    }
    const result = await this.pool.query(
      `
      select * from subject_identities
      where provider = $1 and identity_key = $2
      limit 1
      `,
      [provider, identityKey]
    );
    return this.mapIdentityRow(result.rows[0]);
  }

  async createSubjectWithIdentity(
    subject: SubjectRecord,
    identity: SubjectIdentityRecord
  ): Promise<SubjectIdentityRecord> {
    if (!this.pool) {
      this.subjects.set(subject.subjectId, subject);
      this.identities.set(this.identityMapKey(identity.provider, identity.identityKey), identity);
      return identity;
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
        insert into subjects (subject_id, status, created_at, updated_at)
        values ($1, $2, $3::timestamptz, $4::timestamptz)
        `,
        [subject.subjectId, subject.status, subject.createdAt, subject.updatedAt]
      );
      const identityResult = await client.query(
        `
        insert into subject_identities (
          subject_id,
          provider,
          school_uid,
          identity_key,
          current_student_status,
          school,
          created_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
        returning *
        `,
        [
          identity.subjectId,
          identity.provider,
          identity.schoolUid,
          identity.identityKey,
          identity.currentStudentStatus,
          identity.school,
          identity.createdAt,
          identity.updatedAt
        ]
      );
      await client.query("commit");
      return this.mapIdentityRow(identityResult.rows[0]) as SubjectIdentityRecord;
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") {
        const existing = await this.findIdentity(identity.provider, identity.identityKey);
        if (existing) {
          return existing;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateIdentity(
    provider: string,
    identityKey: string,
    patch: Pick<SubjectIdentityRecord, "schoolUid" | "currentStudentStatus" | "school" | "updatedAt">
  ): Promise<SubjectIdentityRecord> {
    if (!this.pool) {
      const existing = this.identities.get(this.identityMapKey(provider, identityKey));
      if (!existing) {
        throw new Error(`identity not found: ${provider}/${identityKey}`);
      }
      const next = {
        ...existing,
        schoolUid: patch.schoolUid,
        currentStudentStatus: patch.currentStudentStatus,
        school: patch.school,
        updatedAt: patch.updatedAt
      };
      this.identities.set(this.identityMapKey(provider, identityKey), next);
      return next;
    }
    const result = await this.pool.query(
      `
      update subject_identities
      set school_uid = $3,
          current_student_status = $4,
          school = $5,
          updated_at = $6::timestamptz
      where provider = $1 and identity_key = $2
      returning *
      `,
      [provider, identityKey, patch.schoolUid, patch.currentStudentStatus, patch.school, patch.updatedAt]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`identity not found: ${provider}/${identityKey}`);
    }
    return this.mapIdentityRow(row) as SubjectIdentityRecord;
  }

  async getProfile(subjectId: string): Promise<SubjectProfileRecord | null> {
    if (!this.pool) {
      return this.profiles.get(subjectId) ?? null;
    }
    const result = await this.pool.query("select * from subject_profiles where subject_id = $1 limit 1", [subjectId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      subjectId: row.subject_id,
      preferredUsername: row.preferred_username ?? undefined,
      displayName: row.display_name ?? undefined,
      email: row.email ?? undefined,
      emailVerified: row.email_verified,
      updatedAt: row.updated_at.toISOString()
    };
  }

  async upsertProfile(profile: SubjectProfileRecord): Promise<SubjectProfileRecord> {
    if (!this.pool) {
      this.profiles.set(profile.subjectId, profile);
      return profile;
    }
    const result = await this.pool.query(
      `
      insert into subject_profiles (
        subject_id,
        preferred_username,
        display_name,
        email,
        email_verified,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::timestamptz)
      on conflict (subject_id) do update
      set preferred_username = excluded.preferred_username,
          display_name = excluded.display_name,
          email = excluded.email,
          email_verified = excluded.email_verified,
          updated_at = excluded.updated_at
      returning *
      `,
      [
        profile.subjectId,
        profile.preferredUsername ?? null,
        profile.displayName ?? null,
        profile.email ?? null,
        profile.emailVerified,
        profile.updatedAt
      ]
    );
    const row = result.rows[0];
    return {
      subjectId: row.subject_id,
      preferredUsername: row.preferred_username ?? undefined,
      displayName: row.display_name ?? undefined,
      email: row.email ?? undefined,
      emailVerified: row.email_verified,
      updatedAt: row.updated_at.toISOString()
    };
  }

  async findPrincipalBySubjectId(subjectId: string): Promise<AuthenticatedPrincipal | null> {
    if (!this.pool) {
      const subject = this.subjects.get(subjectId);
      if (!subject || subject.status !== "active") {
        return null;
      }
      const identity = [...this.identities.values()]
        .filter((candidate) => candidate.subjectId === subjectId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (!identity) {
        return null;
      }
      const profile = this.profiles.get(subjectId);
      return {
        subjectId,
        schoolUid: identity.schoolUid,
        school: identity.school,
        studentStatus: identity.currentStudentStatus,
        identitySource: identity.provider,
        identityKey: identity.identityKey,
        email: profile?.email,
        emailVerified: profile?.emailVerified ?? false,
        displayName: profile?.displayName,
        preferredUsername: profile?.preferredUsername ?? identity.schoolUid
      };
    }
    const result = await this.pool.query(
      `
      select
        s.subject_id,
        s.status,
        si.provider,
        si.school_uid,
        si.identity_key,
        si.current_student_status,
        si.school,
        sp.preferred_username,
        sp.display_name,
        sp.email,
        sp.email_verified
      from subjects s
      join lateral (
        select *
        from subject_identities
        where subject_id = s.subject_id
        order by updated_at desc
        limit 1
      ) si on true
      left join subject_profiles sp on sp.subject_id = s.subject_id
      where s.subject_id = $1
      limit 1
      `,
      [subjectId]
    );
    const row = result.rows[0];
    if (!row || row.status !== "active") {
      return null;
    }
    return {
      subjectId: row.subject_id,
      schoolUid: row.school_uid,
      school: row.school,
      studentStatus: row.current_student_status,
      identitySource: row.provider,
      identityKey: row.identity_key,
      email: row.email ?? undefined,
      emailVerified: row.email_verified ?? false,
      displayName: row.display_name ?? undefined,
      preferredUsername: row.preferred_username ?? row.school_uid
    };
  }

  async upsertOidcClient(client: OidcClientRecord): Promise<OidcClientRecord> {
    if (!this.pool) {
      this.clients.set(client.clientId, client);
      return client;
    }
    await this.pool.query(
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
    if (!this.pool) {
      return this.clients.get(clientId) ?? null;
    }
    const result = await this.pool.query("select * from oidc_clients where client_id = $1 limit 1", [clientId]);
    return this.mapClientRow(result.rows[0]);
  }

  async listActiveOidcClients(): Promise<OidcClientRecord[]> {
    if (!this.pool) {
      return [...this.clients.values()].filter((client) => client.status === "active");
    }
    const result = await this.pool.query("select * from oidc_clients where status = 'active' order by client_id asc");
    return result.rows
      .map((row: Record<string, unknown>) => this.mapClientRow(row))
      .filter(Boolean) as OidcClientRecord[];
  }

  async upsertArtifact(
    id: string,
    kind: string,
    payload: Record<string, unknown>,
    expiresIn: number
  ): Promise<void> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const artifact: ArtifactRecord = {
      id,
      kind,
      payload,
      expiresAt,
      consumedAt: undefined,
      grantId: typeof payload["grantId"] === "string" ? payload["grantId"] : undefined,
      uid: typeof payload["uid"] === "string" ? payload["uid"] : undefined,
      userCode: typeof payload["userCode"] === "string" ? payload["userCode"] : undefined,
      clientId: typeof payload["clientId"] === "string" ? payload["clientId"] : undefined,
      subjectId:
        typeof payload["accountId"] === "string"
          ? payload["accountId"]
          : typeof payload["sub"] === "string"
            ? payload["sub"]
            : undefined,
      createdAt: now
    };
    if (!this.pool) {
      this.artifacts.set(id, artifact);
      return;
    }
    await this.pool.query(
      `
      insert into oidc_artifacts (
        id,
        kind,
        grant_id,
        uid,
        user_code,
        client_id,
        subject_id,
        payload,
        expires_at,
        consumed_at,
        created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz, $11::timestamptz)
      on conflict (id) do update
      set kind = excluded.kind,
          grant_id = excluded.grant_id,
          uid = excluded.uid,
          user_code = excluded.user_code,
          client_id = excluded.client_id,
          subject_id = excluded.subject_id,
          payload = excluded.payload,
          expires_at = excluded.expires_at,
          consumed_at = excluded.consumed_at
      `,
      [
        artifact.id,
        artifact.kind,
        artifact.grantId ?? null,
        artifact.uid ?? null,
        artifact.userCode ?? null,
        artifact.clientId ?? null,
        artifact.subjectId ?? null,
        JSON.stringify(payload),
        artifact.expiresAt ?? null,
        artifact.consumedAt ?? null,
        artifact.createdAt
      ]
    );
  }

  async findArtifact(id: string): Promise<Record<string, unknown> | undefined> {
    const record = await this.readArtifactById(id);
    return record ? this.mapArtifactPayload(record) : undefined;
  }

  async destroyArtifact(id: string): Promise<void> {
    if (!this.pool) {
      this.artifacts.delete(id);
      return;
    }
    await this.pool.query("delete from oidc_artifacts where id = $1", [id]);
  }

  async consumeArtifact(id: string): Promise<void> {
    if (!this.pool) {
      const record = this.artifacts.get(id);
      if (record) {
        record.consumedAt = new Date().toISOString();
      }
      return;
    }
    await this.pool.query(
      "update oidc_artifacts set consumed_at = now() where id = $1 and consumed_at is null",
      [id]
    );
  }

  async findArtifactByUid(uid: string): Promise<Record<string, unknown> | undefined> {
    const record = await this.readArtifactByColumn("uid", uid);
    return record ? this.mapArtifactPayload(record) : undefined;
  }

  async findArtifactByUserCode(userCode: string): Promise<Record<string, unknown> | undefined> {
    const record = await this.readArtifactByColumn("user_code", userCode);
    return record ? this.mapArtifactPayload(record) : undefined;
  }

  async revokeArtifactsByGrantId(grantId: string): Promise<void> {
    if (!this.pool) {
      for (const [id, artifact] of this.artifacts.entries()) {
        if (artifact.grantId === grantId) {
          this.artifacts.delete(id);
        }
      }
      return;
    }
    await this.pool.query("delete from oidc_artifacts where grant_id = $1", [grantId]);
  }

  async saveInteractionLogin(uid: string, value: PendingInteractionLogin): Promise<void> {
    await this.upsertArtifact(`interaction_login:${uid}`, "InteractionLogin", value as unknown as Record<string, unknown>, this.config.interactionTtlSeconds);
  }

  async getInteractionLogin(uid: string): Promise<PendingInteractionLogin | undefined> {
    const payload = await this.findArtifact(`interaction_login:${uid}`);
    return payload as PendingInteractionLogin | undefined;
  }

  async deleteInteractionLogin(uid: string): Promise<void> {
    await this.destroyArtifact(`interaction_login:${uid}`);
  }

  async upsertSigningKey(key: OidcSigningKeyRecord): Promise<OidcSigningKeyRecord> {
    if (!this.pool) {
      this.signingKeys.set(key.kid, key);
      return key;
    }
    await this.pool.query(
      `
      insert into oidc_signing_keys (
        kid,
        alg,
        use,
        public_jwk,
        private_jwk_ciphertext,
        status,
        created_at,
        activated_at,
        retired_at
      )
      values ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)
      on conflict (kid) do update
      set alg = excluded.alg,
          use = excluded.use,
          public_jwk = excluded.public_jwk,
          private_jwk_ciphertext = excluded.private_jwk_ciphertext,
          status = excluded.status,
          activated_at = excluded.activated_at,
          retired_at = excluded.retired_at
      `,
      [
        key.kid,
        key.alg,
        key.use,
        JSON.stringify(key.publicJwk),
        key.privateJwkCiphertext,
        key.status,
        key.createdAt,
        key.activatedAt ?? null,
        key.retiredAt ?? null
      ]
    );
    return key;
  }

  async listSigningKeys(statuses: Array<OidcSigningKeyRecord["status"]> = ["active", "retiring"]): Promise<OidcSigningKeyRecord[]> {
    if (!this.pool) {
      return [...this.signingKeys.values()]
        .filter((item) => statuses.includes(item.status))
        .sort((left, right) => left.status.localeCompare(right.status) || right.createdAt.localeCompare(left.createdAt));
    }
    const result = await this.pool.query(
      `
      select * from oidc_signing_keys
      where status = any($1::text[])
      order by case when status = 'active' then 0 else 1 end, created_at desc
      `,
      [statuses]
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      kid: String(row["kid"]),
      alg: String(row["alg"]),
      use: String(row["use"]),
      publicJwk: row["public_jwk"] as JsonWebKey,
      privateJwkCiphertext: String(row["private_jwk_ciphertext"]),
      status: row["status"] as OidcSigningKeyRecord["status"],
      createdAt: (row["created_at"] as Date).toISOString(),
      activatedAt: row["activated_at"] ? (row["activated_at"] as Date).toISOString() : undefined,
      retiredAt: row["retired_at"] ? (row["retired_at"] as Date).toISOString() : undefined
    }));
  }

  async loadPrivateSigningJwks(statuses: Array<OidcSigningKeyRecord["status"]> = ["active", "retiring"]) {
    const keys = await this.listSigningKeys(statuses);
    return keys.map((key) => ({
      ...decryptJson<JsonWebKey>(this.config.keyEncryptionSecret, key.privateJwkCiphertext),
      use: key.use,
      alg: key.alg,
      kid: key.kid
    })) as Array<JsonWebKey & { kid: string; alg: string; use: string }>;
  }

  encryptPrivateJwk(jwk: JsonWebKey) {
    return encryptJson(this.config.keyEncryptionSecret, jwk);
  }

  private mapIdentityRow(row: Record<string, unknown> | undefined): SubjectIdentityRecord | null {
    if (!row) {
      return null;
    }
    return {
      subjectId: String(row["subject_id"]),
      provider: String(row["provider"]),
      schoolUid: String(row["school_uid"]),
      identityKey: String(row["identity_key"]),
      currentStudentStatus: row["current_student_status"] as SubjectIdentityRecord["currentStudentStatus"],
      school: String(row["school"]),
      createdAt: (row["created_at"] as Date).toISOString(),
      updatedAt: (row["updated_at"] as Date).toISOString()
    };
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
      scopeWhitelist: row["scope_whitelist"] as OidcScope[],
      requirePkce: Boolean(row["require_pkce"]),
      status: row["status"] as OidcClientRecord["status"],
      createdAt: (row["created_at"] as Date).toISOString(),
      updatedAt: (row["updated_at"] as Date).toISOString()
    };
  }

  private async readArtifactById(id: string): Promise<ArtifactRecord | null> {
    if (!this.pool) {
      const record = this.artifacts.get(id);
      if (!record) {
        return null;
      }
      if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
        this.artifacts.delete(id);
        return null;
      }
      return record;
    }
    const result = await this.pool.query(
      `
      select * from oidc_artifacts
      where id = $1
        and (expires_at is null or expires_at > now())
      limit 1
      `,
      [id]
    );
    return this.mapArtifactRow(result.rows[0]);
  }

  private async readArtifactByColumn(column: "uid" | "user_code", value: string): Promise<ArtifactRecord | null> {
    if (!this.pool) {
      const record = [...this.artifacts.values()].find((candidate) => candidate[column === "uid" ? "uid" : "userCode"] === value);
      if (!record) {
        return null;
      }
      if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
        this.artifacts.delete(record.id);
        return null;
      }
      return record;
    }
    const result = await this.pool.query(
      `
      select * from oidc_artifacts
      where ${column} = $1
        and (expires_at is null or expires_at > now())
      limit 1
      `,
      [value]
    );
    return this.mapArtifactRow(result.rows[0]);
  }

  private mapArtifactRow(row: Record<string, unknown> | undefined): ArtifactRecord | null {
    if (!row) {
      return null;
    }
    return {
      id: String(row["id"]),
      kind: String(row["kind"]),
      grantId: (row["grant_id"] as string | null) ?? undefined,
      uid: (row["uid"] as string | null) ?? undefined,
      userCode: (row["user_code"] as string | null) ?? undefined,
      clientId: (row["client_id"] as string | null) ?? undefined,
      subjectId: (row["subject_id"] as string | null) ?? undefined,
      payload: row["payload"] as Record<string, unknown>,
      expiresAt: row["expires_at"] ? (row["expires_at"] as Date).toISOString() : undefined,
      consumedAt: row["consumed_at"] ? (row["consumed_at"] as Date).toISOString() : undefined,
      createdAt: (row["created_at"] as Date).toISOString()
    };
  }

  private mapArtifactPayload(record: ArtifactRecord): Record<string, unknown> {
    return {
      ...record.payload,
      ...(record.consumedAt
        ? {
            consumed: Math.floor(new Date(record.consumedAt).getTime() / 1000)
          }
        : {})
    };
  }
}
