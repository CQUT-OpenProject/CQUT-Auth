import type {
  AuthenticatedPrincipal,
  SubjectIdentityRecord,
  SubjectProfileRecord,
  SubjectRecord,
} from "../identity/index.js";
import { Pool } from "pg";
import type { OidcOpConfig } from "../config.js";
import {
  ensureArtifactCleanupJob,
  ArtifactCleanupConfigurationError,
} from "./artifact-cleanup.scheduler.js";
import { ArtifactPayloadCipherServiceImpl } from "./artifact-payload-cipher.service.js";
import type {
  ManagementSessionRecord,
  ActiveOidcClientRecord,
  ClientRevisionStatus,
  OidcClientAuditRecord,
  OidcClientRecord,
  OidcClientRevisionRecord,
  OidcPersistence,
  OidcSigningKeyRecord,
  PendingInteractionLogin,
} from "./contracts.js";
import { IdentityRepositoryImpl } from "./identity.repository.js";
import { JwkCipherServiceImpl } from "./jwk-cipher.service.js";
import { OidcArtifactRepositoryImpl } from "./oidc-artifact.repository.js";
import { OidcClientRepositoryImpl } from "./oidc-client.repository.js";
import { ManagementSessionRepositoryImpl } from "./management-session.repository.js";
import { SigningKeyRepositoryImpl } from "./signing-key.repository.js";

export class OidcPersistenceImpl implements OidcPersistence {
  private readonly logger = console;
  private pool: Pool | undefined;
  private readonly jwkCipherService: JwkCipherServiceImpl;
  private readonly artifactPayloadCipherService: ArtifactPayloadCipherServiceImpl;
  private readonly identityRepository: IdentityRepositoryImpl;
  private readonly oidcClientRepository: OidcClientRepositoryImpl;
  private readonly managementSessionRepository: ManagementSessionRepositoryImpl;
  private readonly oidcArtifactRepository: OidcArtifactRepositoryImpl;
  private readonly signingKeyRepository: SigningKeyRepositoryImpl;

  constructor(private readonly config: OidcOpConfig) {
    const poolProvider = () => this.pool;
    this.jwkCipherService = new JwkCipherServiceImpl(
      config.keyEncryptionSecret,
    );
    this.artifactPayloadCipherService = new ArtifactPayloadCipherServiceImpl(
      config.artifactEncryptionSecret,
    );
    this.identityRepository = new IdentityRepositoryImpl(poolProvider);
    this.oidcClientRepository = new OidcClientRepositoryImpl(poolProvider);
    this.managementSessionRepository = new ManagementSessionRepositoryImpl(
      poolProvider,
    );
    this.oidcArtifactRepository = new OidcArtifactRepositoryImpl(
      poolProvider,
      config.interactionTtlSeconds,
      {
        enabled: config.artifactOpportunisticCleanupEnabled,
        sampleRate: config.artifactOpportunisticCleanupSampleRate,
        batchSize: config.artifactOpportunisticCleanupBatchSize,
        minIntervalSeconds: config.artifactOpportunisticCleanupIntervalSeconds,
      },
      this.artifactPayloadCipherService,
    );
    this.signingKeyRepository = new SigningKeyRepositoryImpl(
      poolProvider,
      this.jwkCipherService,
    );
  }

  async init() {
    if (!this.config.databaseUrl) {
      if (this.config.allowInMemoryStore) {
        this.logger.warn(
          "DATABASE_URL not configured for oidc-op, using in-memory store",
        );
        return;
      }
      throw new Error("DATABASE_URL is required for oidc-op");
    }

    try {
      this.pool = new Pool({
        connectionString: this.config.databaseUrl,
      });
      await this.pool.query("select 1");
      await this.ensureSchema();
      await ensureArtifactCleanupJob(this.pool, {
        enabled: this.config.artifactCleanupEnabled,
        schedule: this.config.artifactCleanupCron,
        batchSize: this.config.artifactCleanupBatchSize,
      });
    } catch (error) {
      await this.pool?.end().catch(() => undefined);
      this.pool = undefined;
      if (error instanceof ArtifactCleanupConfigurationError) {
        throw error;
      }
      if (!this.config.allowInMemoryStore) {
        throw error;
      }
      this.logger.warn(
        `database unavailable for oidc-op, using in-memory store: ${error instanceof Error ? error.message : "unknown error"}`,
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

  async findSubject(subjectId: string): Promise<SubjectRecord | null> {
    return this.identityRepository.findSubject(subjectId);
  }

  async findIdentity(
    provider: string,
    identityKey: string,
  ): Promise<SubjectIdentityRecord | null> {
    return this.identityRepository.findIdentity(provider, identityKey);
  }

  async createSubjectWithIdentity(
    subject: SubjectRecord,
    identity: SubjectIdentityRecord,
  ): Promise<SubjectIdentityRecord> {
    return this.identityRepository.createSubjectWithIdentity(subject, identity);
  }

  async updateIdentity(
    provider: string,
    identityKey: string,
    patch: Pick<
      SubjectIdentityRecord,
      "schoolUid" | "currentStudentStatus" | "school" | "updatedAt"
    >,
  ): Promise<SubjectIdentityRecord> {
    return this.identityRepository.updateIdentity(provider, identityKey, patch);
  }

  async getProfile(subjectId: string): Promise<SubjectProfileRecord | null> {
    return this.identityRepository.getProfile(subjectId);
  }

  async upsertProfile(
    profile: SubjectProfileRecord,
  ): Promise<SubjectProfileRecord> {
    return this.identityRepository.upsertProfile(profile);
  }

  async findPrincipalBySubjectId(
    subjectId: string,
  ): Promise<AuthenticatedPrincipal | null> {
    return this.identityRepository.findPrincipalBySubjectId(subjectId);
  }

  async upsertOidcClient(
    client: ActiveOidcClientRecord,
  ): Promise<ActiveOidcClientRecord> {
    return this.oidcClientRepository.upsertOidcClient(client);
  }

  async countOidcClients(): Promise<number> {
    return this.oidcClientRepository.countOidcClients();
  }

  async initializeOidcClientsIfEmpty(
    clients: ActiveOidcClientRecord[],
    audits: OidcClientAuditRecord[],
  ) {
    return this.oidcClientRepository.initializeOidcClientsIfEmpty(
      clients,
      audits,
    );
  }

  async createOidcClient(
    client: OidcClientRecord,
    revision: OidcClientRevisionRecord,
    audits: OidcClientAuditRecord[],
    ownerLimits?: {
      maxNonDisabledClients: number;
      maxPendingClients: number;
    },
  ) {
    return this.oidcClientRepository.createOidcClient(
      client,
      revision,
      audits,
      ownerLimits,
    );
  }

  async updateOidcClientMetadata(
    clientId: string,
    patch: Pick<OidcClientRecord, "displayName" | "description" | "updatedAt">,
    expectedVersion: number,
    audit: OidcClientAuditRecord,
  ) {
    return this.oidcClientRepository.updateOidcClientMetadata(
      clientId,
      patch,
      expectedVersion,
      audit,
    );
  }

  async saveOidcClientRevision(
    clientId: string,
    revision: OidcClientRevisionRecord,
    expectedRevisionId: number | null,
    expectedRevisionVersion: number | null,
    audits: OidcClientAuditRecord[],
    maxPendingClients?: number,
  ) {
    return this.oidcClientRepository.saveOidcClientRevision(
      clientId,
      revision,
      expectedRevisionId,
      expectedRevisionVersion,
      audits,
      maxPendingClients,
    );
  }

  async transitionOidcClientRevision(
    clientId: string,
    revisionId: number,
    expectedVersion: number,
    nextStatus: ClientRevisionStatus,
    reason: string | undefined,
    audit: OidcClientAuditRecord,
    maxPendingClients?: number,
  ) {
    return this.oidcClientRepository.transitionOidcClientRevision(
      clientId,
      revisionId,
      expectedVersion,
      nextStatus,
      reason,
      audit,
      maxPendingClients,
    );
  }

  async approveOidcClientRevision(
    clientId: string,
    revisionId: number,
    expectedVersion: number,
    audits: OidcClientAuditRecord[],
  ) {
    return this.oidcClientRepository.approveOidcClientRevision(
      clientId,
      revisionId,
      expectedVersion,
      audits,
    );
  }

  async disableOidcClient(
    clientId: string,
    expectedVersion: number,
    updatedAt: string,
    audit: OidcClientAuditRecord,
  ) {
    return this.oidcClientRepository.disableOidcClient(
      clientId,
      expectedVersion,
      updatedAt,
      audit,
    );
  }

  async findManagedOidcClient(clientId: string) {
    return this.oidcClientRepository.findManagedOidcClient(clientId);
  }

  async findOidcClient(
    clientId: string,
  ): Promise<ActiveOidcClientRecord | null> {
    return this.oidcClientRepository.findOidcClient(clientId);
  }

  async listActiveOidcClients(): Promise<ActiveOidcClientRecord[]> {
    return this.oidcClientRepository.listActiveOidcClients();
  }

  async listOidcClientsByOwner(ownerSubjectId: string) {
    return this.oidcClientRepository.listOidcClientsByOwner(ownerSubjectId);
  }

  async listOidcClients() {
    return this.oidcClientRepository.listOidcClients();
  }

  async listPendingOidcClients() {
    return this.oidcClientRepository.listPendingOidcClients();
  }

  async listOidcClientAuditLogs(clientId?: string) {
    return this.oidcClientRepository.listOidcClientAuditLogs(clientId);
  }

  async createManagementSession(session: ManagementSessionRecord) {
    return this.managementSessionRepository.createManagementSession(session);
  }

  async findManagementSession(tokenHash: string) {
    return this.managementSessionRepository.findManagementSession(tokenHash);
  }

  async touchManagementSession(tokenHash: string, lastSeenAt: string) {
    return this.managementSessionRepository.touchManagementSession(
      tokenHash,
      lastSeenAt,
    );
  }

  async deleteManagementSession(tokenHash: string) {
    return this.managementSessionRepository.deleteManagementSession(tokenHash);
  }

  async deleteExpiredManagementSessions(now: string) {
    return this.managementSessionRepository.deleteExpiredManagementSessions(
      now,
    );
  }

  async upsertArtifact(
    id: string,
    kind: string,
    payload: Record<string, unknown>,
    expiresIn: number,
  ): Promise<void> {
    return this.oidcArtifactRepository.upsertArtifact(
      id,
      kind,
      payload,
      expiresIn,
    );
  }

  async findArtifact(id: string): Promise<Record<string, unknown> | undefined> {
    return this.oidcArtifactRepository.findArtifact(id);
  }

  async destroyArtifact(id: string): Promise<void> {
    return this.oidcArtifactRepository.destroyArtifact(id);
  }

  async consumeArtifact(id: string): Promise<void> {
    return this.oidcArtifactRepository.consumeArtifact(id);
  }

  async findArtifactByUid(
    uid: string,
    kind?: string,
  ): Promise<Record<string, unknown> | undefined> {
    return this.oidcArtifactRepository.findArtifactByUid(uid, kind);
  }

  async findArtifactByUserCode(
    userCode: string,
  ): Promise<Record<string, unknown> | undefined> {
    return this.oidcArtifactRepository.findArtifactByUserCode(userCode);
  }

  async revokeArtifactsByGrantId(grantId: string): Promise<void> {
    return this.oidcArtifactRepository.revokeArtifactsByGrantId(grantId);
  }

  async saveInteractionLogin(
    uid: string,
    value: PendingInteractionLogin,
  ): Promise<void> {
    return this.oidcArtifactRepository.saveInteractionLogin(uid, value);
  }

  async getInteractionLogin(
    uid: string,
  ): Promise<PendingInteractionLogin | undefined> {
    return this.oidcArtifactRepository.getInteractionLogin(uid);
  }

  async deleteInteractionLogin(uid: string): Promise<void> {
    return this.oidcArtifactRepository.deleteInteractionLogin(uid);
  }

  async upsertSigningKey(
    key: OidcSigningKeyRecord,
  ): Promise<OidcSigningKeyRecord> {
    return this.signingKeyRepository.upsertSigningKey(key);
  }

  async listSigningKeys(
    statuses: Array<OidcSigningKeyRecord["status"]> = ["active", "retiring"],
  ): Promise<OidcSigningKeyRecord[]> {
    return this.signingKeyRepository.listSigningKeys(statuses);
  }

  async loadPrivateSigningJwks(
    statuses: Array<OidcSigningKeyRecord["status"]> = ["active", "retiring"],
  ) {
    return this.signingKeyRepository.loadPrivateSigningJwks(statuses);
  }

  async encryptPrivateJwk(jwk: JsonWebKey) {
    return this.jwkCipherService.encryptPrivateJwk(jwk);
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
      create index if not exists idx_subject_identities_subject_id_updated_at_desc
      on subject_identities (subject_id, updated_at desc);
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
        display_name text not null,
        description text not null default '',
        owner_subject_id text references subjects(subject_id),
        client_type text not null check (client_type in ('web', 'spa')),
        auto_consent boolean not null default false,
        lifecycle_status text not null default 'draft' check (lifecycle_status in ('draft', 'active', 'disabled')),
        active_revision_id bigint,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        version integer not null default 1 check (version > 0)
      );
    `);
    await this.pool.query(`
      create table if not exists oidc_client_revisions (
        revision_id bigserial primary key,
        client_id text not null references oidc_clients(client_id),
        revision_number integer not null check (revision_number > 0),
        review_status text not null check (review_status in ('draft', 'pending', 'approved', 'rejected')),
        redirect_uris jsonb not null,
        post_logout_redirect_uris jsonb not null default '[]'::jsonb,
        scope_whitelist jsonb not null,
        rejection_reason text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        version integer not null default 1 check (version > 0),
        unique (client_id, revision_number),
        unique (client_id, revision_id)
      );
    `);
    await this.pool.query(`
      do $$ begin
        alter table oidc_clients add constraint fk_oidc_clients_active_revision
        foreign key (client_id, active_revision_id)
        references oidc_client_revisions(client_id, revision_id);
      exception when duplicate_object then null;
      end $$;
    `);
    await this.assertFreshOidcClientSchema();
    await this.pool.query(`
      create index if not exists idx_oidc_clients_owner_updated
      on oidc_clients (owner_subject_id, updated_at desc);
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_clients_status_updated
      on oidc_clients (lifecycle_status, updated_at desc);
    `);
    await this.pool.query(`
      create unique index if not exists uq_oidc_client_revisions_open
      on oidc_client_revisions (client_id)
      where review_status in ('draft', 'pending');
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_client_revisions_review_updated
      on oidc_client_revisions (review_status, updated_at desc);
    `);
    await this.pool.query(`
      create table if not exists oidc_client_audit_logs (
        id bigserial primary key,
        client_id text not null,
        revision_id bigint,
        revision_number integer,
        actor_subject_id text,
        action text not null,
        changed_fields jsonb not null default '[]'::jsonb,
        previous_client_status text,
        new_client_status text,
        previous_revision_status text,
        new_revision_status text,
        reason text,
        source_ip text,
        created_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_client_audit_logs_client_created
      on oidc_client_audit_logs (client_id, created_at desc);
    `);
    await this.pool.query(`
      create table if not exists management_sessions (
        token_hash text primary key,
        subject_id text not null references subjects(subject_id),
        created_at timestamptz not null,
        last_seen_at timestamptz not null,
        expires_at timestamptz not null
      );
    `);
    await this.pool.query(`
      create index if not exists idx_management_sessions_expires_at
      on management_sessions (expires_at);
    `);
    await this.pool.query(`
      create table if not exists oidc_artifacts (
        id text primary key,
        kind text not null,
        grant_id_hash text,
        uid_hash text,
        user_code_hash text,
        payload jsonb not null,
        expires_at timestamptz,
        consumed_at timestamptz,
        created_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      alter table oidc_artifacts
      add column if not exists grant_id_hash text,
      add column if not exists uid_hash text,
      add column if not exists user_code_hash text;
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_kind_expires_at
      on oidc_artifacts (kind, expires_at);
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_expires_at
      on oidc_artifacts (expires_at);
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_uid_hash
      on oidc_artifacts (uid_hash);
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_uid_hash_kind
      on oidc_artifacts (uid_hash, kind);
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_user_code_hash
      on oidc_artifacts (user_code_hash);
    `);
    await this.pool.query(`
      create index if not exists idx_oidc_artifacts_grant_id_hash
      on oidc_artifacts (grant_id_hash);
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

  private async assertFreshOidcClientSchema() {
    if (!this.pool) {
      return;
    }
    const result = await this.pool.query(
      `select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'oidc_clients'`,
    );
    const columns = new Set(
      result.rows.map((row: { column_name: string }) => row.column_name),
    );
    const required = [
      "display_name",
      "description",
      "owner_subject_id",
      "client_type",
      "lifecycle_status",
      "active_revision_id",
      "version",
    ];
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `incompatible legacy oidc_clients schema; rebuild the database for the client management release (missing: ${missing.join(", ")})`,
      );
    }
  }
}
