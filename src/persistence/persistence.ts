import type {
  AuthenticatedPrincipal,
  SubjectIdentityRecord,
  SubjectProfileRecord,
  SubjectRecord,
} from "../identity/index.js";
import { Pool } from "pg";
import type { StaticConfig } from "../config.js";
import {
  ensureArtifactCleanupJob,
  ArtifactCleanupConfigurationError,
} from "./artifact-cleanup.scheduler.js";
import { ArtifactPayloadCipherServiceImpl } from "./artifact-payload-cipher.service.js";
import type {
  ManagementSessionRecord,
  ActiveOidcClientRecord,
  ClientRevisionStatus,
  ClientProjectLimits,
  OidcClientAuditRecord,
  OidcClientRecord,
  OidcClientSecretRecord,
  OidcClientRevisionRecord,
  ProjectAuditRecord,
  ProjectCreateLimits,
  ProjectMemberRecord,
  ProjectRecord,
  ProjectRole,
  OidcSigningKeyRecord,
  PendingInteractionLogin,
  AppSettingRecord,
  InteractionEmailVerificationResult,
} from "./contracts.js";
import type {
  AppSettingsRepository,
  IdentityRepository,
  JwkCipherService,
  ManagementSessionRepository,
  OidcArtifactRepository,
  OidcClientRepository,
  PersistenceRuntime,
  ProjectRepository,
  SigningKeyRepository,
} from "./contracts.js";
import type { ProjectWriteAuthorization } from "../projects/project-access.js";
import { IdentityRepositoryImpl } from "./identity.repository.js";
import { JwkCipherServiceImpl } from "./jwk-cipher.service.js";
import { OidcArtifactRepositoryImpl } from "./oidc-artifact.repository.js";
import {
  MemoryOidcClientRepository,
  PostgresOidcClientRepository,
} from "./oidc-client.repository.js";
import { ManagementSessionRepositoryImpl } from "./management-session.repository.js";
import { ProjectRepositoryImpl } from "./project.repository.js";
import { SigningKeyRepositoryImpl } from "./signing-key.repository.js";
import { AppSettingsRepositoryImpl } from "./app-settings.repository.js";

export class PersistenceRuntimeImpl {
  private readonly logger = console;
  private pool: Pool | undefined;
  readonly jwkCipherService: JwkCipherServiceImpl;
  private readonly artifactPayloadCipherService: ArtifactPayloadCipherServiceImpl;
  readonly identityRepository: IdentityRepositoryImpl;
  oidcClientRepository!: OidcClientRepository;
  readonly projectRepository: ProjectRepositoryImpl;
  readonly managementSessionRepository: ManagementSessionRepositoryImpl;
  readonly oidcArtifactRepository: OidcArtifactRepositoryImpl;
  readonly signingKeyRepository: SigningKeyRepositoryImpl;
  readonly appSettingsRepository: AppSettingsRepositoryImpl;

  constructor(private readonly config: StaticConfig) {
    const poolProvider = () => this.pool;
    this.jwkCipherService = new JwkCipherServiceImpl(
      config.keyEncryptionSecret,
    );
    this.artifactPayloadCipherService = new ArtifactPayloadCipherServiceImpl(
      config.artifactEncryptionSecret,
    );
    this.identityRepository = new IdentityRepositoryImpl(poolProvider);
    this.projectRepository = new ProjectRepositoryImpl(
      poolProvider,
      async (subjectId) =>
        (await this.identityRepository.findSubject(subjectId))?.status ===
        "active",
    );
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
      async (clientId) => {
        const managed =
          await this.oidcClientRepository.findManagedOidcClient(clientId);
        return managed
          ? {
              lifecycleStatus: managed.client.lifecycleStatus,
              authorizationGeneration: managed.client.authorizationGeneration,
            }
          : null;
      },
    );
    this.signingKeyRepository = new SigningKeyRepositoryImpl(
      poolProvider,
      this.jwkCipherService,
    );
    this.appSettingsRepository = new AppSettingsRepositoryImpl(poolProvider);
  }

  async init() {
    if (!this.config.databaseUrl) {
      if (this.config.allowInMemoryStore) {
        this.logger.warn(
          "DATABASE_URL not configured for oidc-op, using in-memory store",
        );
        await this.projectRepository.ensureSystemProject();
        this.selectClientRepository();
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
      await this.projectRepository.ensureSystemProject();
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
      await this.projectRepository.ensureSystemProject();
    }
    this.selectClientRepository();
  }

  selectClientRepository() {
    const hashClientId = (clientId: string) =>
      this.artifactPayloadCipherService.hashLookupValue(clientId);
    const revokeArtifacts = (clientId: string) =>
      this.oidcArtifactRepository.revokeArtifactsByClientId(clientId);
    this.oidcClientRepository = this.pool
      ? new PostgresOidcClientRepository(
          this.pool,
          hashClientId,
          revokeArtifacts,
        )
      : new MemoryOidcClientRepository(
          hashClientId,
          revokeArtifacts,
          (authorization, clientProjectId, mutation) =>
            this.projectRepository.withMemoryProjectWrite(
              authorization,
              clientProjectId,
              mutation,
            ),
        );
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

  async ensureSystemProject() {
    return this.projectRepository.ensureSystemProject();
  }

  async createProject(
    project: ProjectRecord,
    owner: ProjectMemberRecord,
    audit: ProjectAuditRecord,
    limits?: ProjectCreateLimits,
  ) {
    return this.projectRepository.createProject(project, owner, audit, limits);
  }

  async findProject(projectId: string) {
    return this.projectRepository.findProject(projectId);
  }

  async findProjectRole(projectId: string, subjectId: string) {
    return this.projectRepository.findProjectRole(projectId, subjectId);
  }

  async listProjectsForSubject(subjectId: string, includeAll: boolean) {
    return this.projectRepository.listProjectsForSubject(subjectId, includeAll);
  }

  async listProjectMembers(projectId: string) {
    return this.projectRepository.listProjectMembers(projectId);
  }

  async updateProject(
    projectId: string,
    expectedVersion: number,
    patch: Pick<ProjectRecord, "name" | "description" | "status" | "updatedAt">,
    audit: ProjectAuditRecord,
  ) {
    return this.projectRepository.updateProject(
      projectId,
      expectedVersion,
      patch,
      audit,
    );
  }

  async addProjectMember(
    member: ProjectMemberRecord,
    expectedVersion: number,
    audit: ProjectAuditRecord,
  ) {
    return this.projectRepository.addProjectMember(
      member,
      expectedVersion,
      audit,
    );
  }

  async updateProjectMemberRole(
    projectId: string,
    subjectId: string,
    role: ProjectRole,
    expectedVersion: number,
    updatedAt: string,
    audit: ProjectAuditRecord,
  ) {
    return this.projectRepository.updateProjectMemberRole(
      projectId,
      subjectId,
      role,
      expectedVersion,
      updatedAt,
      audit,
    );
  }

  async removeProjectMember(
    projectId: string,
    subjectId: string,
    expectedVersion: number,
    updatedAt: string,
    audit: ProjectAuditRecord,
  ) {
    return this.projectRepository.removeProjectMember(
      projectId,
      subjectId,
      expectedVersion,
      updatedAt,
      audit,
    );
  }

  async transferProjectOwnership(
    projectId: string,
    fromSubjectId: string,
    toSubjectId: string,
    expectedVersion: number,
    updatedAt: string,
    audits: ProjectAuditRecord[],
  ) {
    return this.projectRepository.transferProjectOwnership(
      projectId,
      fromSubjectId,
      toSubjectId,
      expectedVersion,
      updatedAt,
      audits,
    );
  }

  async listProjectAuditLogs(
    projectId: string,
    limit: number,
    beforeId?: number,
  ) {
    const projectAudits = await this.projectRepository.listProjectAuditLogs(
      projectId,
      limit,
      beforeId,
    );
    if (this.pool) return projectAudits;
    const clientAudits =
      await this.oidcClientRepository.listOidcClientAuditLogs();
    const matching = [];
    for (const audit of clientAudits) {
      const client = await this.oidcClientRepository.findManagedOidcClient(
        audit.clientId,
      );
      if (client?.client.projectId === projectId) {
        matching.push({ ...audit, projectId });
      }
    }
    return [...projectAudits, ...matching]
      .filter(
        (audit) =>
          !beforeId || (audit.id ?? Number.MAX_SAFE_INTEGER) < beforeId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
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
    secret: OidcClientSecretRecord | undefined,
    audits: OidcClientAuditRecord[],
    projectLimits: ClientProjectLimits | undefined,
    authorization: ProjectWriteAuthorization,
  ) {
    return this.oidcClientRepository.createOidcClient(
      client,
      revision,
      secret,
      audits,
      projectLimits,
      authorization,
    );
  }

  async updateOidcClientMetadata(
    clientId: string,
    patch: Pick<OidcClientRecord, "displayName" | "description" | "updatedAt">,
    expectedVersion: number,
    audit: OidcClientAuditRecord,
    authorization: ProjectWriteAuthorization,
  ) {
    return this.oidcClientRepository.updateOidcClientMetadata(
      clientId,
      patch,
      expectedVersion,
      audit,
      authorization,
    );
  }

  async saveOidcClientRevision(
    clientId: string,
    revision: OidcClientRevisionRecord,
    expectedRevisionId: number | null,
    expectedRevisionVersion: number | null,
    audits: OidcClientAuditRecord[],
    projectLimits: ClientProjectLimits | undefined,
    authorization: ProjectWriteAuthorization,
  ) {
    return this.oidcClientRepository.saveOidcClientRevision(
      clientId,
      revision,
      expectedRevisionId,
      expectedRevisionVersion,
      audits,
      projectLimits,
      authorization,
    );
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
  ) {
    return this.oidcClientRepository.transitionOidcClientRevision(
      clientId,
      revisionId,
      expectedVersion,
      nextStatus,
      reason,
      audit,
      projectLimits,
      authorization,
    );
  }

  async approveOidcClientRevision(
    clientId: string,
    revisionId: number,
    expectedVersion: number,
    audits: OidcClientAuditRecord[],
    authorization: ProjectWriteAuthorization,
  ) {
    return this.oidcClientRepository.approveOidcClientRevision(
      clientId,
      revisionId,
      expectedVersion,
      audits,
      authorization,
    );
  }

  async disableOidcClient(
    clientId: string,
    expectedVersion: number,
    updatedAt: string,
    audits: OidcClientAuditRecord[],
    authorization: ProjectWriteAuthorization,
  ) {
    return this.oidcClientRepository.disableOidcClient(
      clientId,
      expectedVersion,
      updatedAt,
      audits,
      authorization,
    );
  }

  async rotateOidcClientSecret(
    clientId: string,
    secret: OidcClientSecretRecord,
    expectedClientVersion: number,
    gracePeriodSeconds: number,
    minimumRotationIntervalSeconds: number,
    audit: OidcClientAuditRecord,
    authorization: ProjectWriteAuthorization,
  ) {
    return this.oidcClientRepository.rotateOidcClientSecret(
      clientId,
      secret,
      expectedClientVersion,
      gracePeriodSeconds,
      minimumRotationIntervalSeconds,
      audit,
      authorization,
    );
  }

  async revokeOidcClientSecret(
    clientId: string,
    secretId: string,
    expectedClientVersion: number,
    expectedSecretVersion: number,
    updatedAt: string,
    audit: OidcClientAuditRecord,
    authorization: ProjectWriteAuthorization,
  ) {
    return this.oidcClientRepository.revokeOidcClientSecret(
      clientId,
      secretId,
      expectedClientVersion,
      expectedSecretVersion,
      updatedAt,
      audit,
      authorization,
    );
  }

  async revokeOidcClientAuthorizations(
    clientId: string,
    expectedClientVersion: number,
    updatedAt: string,
    audit: OidcClientAuditRecord,
    authorization: ProjectWriteAuthorization,
  ) {
    return this.oidcClientRepository.revokeOidcClientAuthorizations(
      clientId,
      expectedClientVersion,
      updatedAt,
      audit,
      authorization,
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

  async listOidcClientsByProject(projectId: string) {
    return this.oidcClientRepository.listOidcClientsByProject(projectId);
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
    authorizationGeneration?: number,
  ): Promise<void> {
    return this.oidcArtifactRepository.upsertArtifact(
      id,
      kind,
      payload,
      expiresIn,
      authorizationGeneration,
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

  async revokeArtifactsByClientId(clientId: string): Promise<void> {
    return this.oidcArtifactRepository.revokeArtifactsByClientId(clientId);
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

  async verifyInteractionEmailCode(
    uid: string,
    expectedCodeHash: string,
    inputCodeHash: string,
    now: number,
    maxAttempts: number,
  ): Promise<InteractionEmailVerificationResult> {
    return this.oidcArtifactRepository.verifyInteractionEmailCode(
      uid,
      expectedCodeHash,
      inputCodeHash,
      now,
      maxAttempts,
    );
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

  async getAppSetting(key: string): Promise<AppSettingRecord | null> {
    return this.appSettingsRepository.getAppSetting(key);
  }

  async saveAppSetting(
    input: Parameters<AppSettingsRepository["saveAppSetting"]>[0],
  ) {
    return this.appSettingsRepository.saveAppSetting(input);
  }

  async listAppSettingAuditLogs(key: string, limit: number) {
    return this.appSettingsRepository.listAppSettingAuditLogs(key, limit);
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
      create table if not exists projects (
        project_id text primary key,
        name text not null,
        description text not null default '',
        status text not null default 'active' check (status in ('active', 'archived')),
        created_by_subject_id text references subjects(subject_id),
        version integer not null default 1 check (version > 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table if not exists project_members (
        project_id text not null references projects(project_id),
        subject_id text not null references subjects(subject_id),
        role text not null check (role in ('owner', 'maintainer', 'viewer')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (project_id, subject_id)
      );
      create index if not exists idx_project_members_subject
      on project_members (subject_id, project_id);
    `);
    await this.pool.query(`
      create table if not exists oidc_clients (
        client_id text primary key,
        project_id text not null references projects(project_id),
        display_name text not null,
        description text not null default '',
        created_by_subject_id text references subjects(subject_id),
        client_type text not null check (client_type in ('web', 'spa')),
        auto_consent boolean not null default false,
        lifecycle_status text not null default 'draft' check (lifecycle_status in ('draft', 'active', 'disabled')),
        active_revision_id bigint,
        authorization_generation integer not null default 1 check (authorization_generation > 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        version integer not null default 1 check (version > 0)
      );
    `);
    await this.pool.query(`
      create table if not exists oidc_client_secrets (
        secret_id text primary key,
        client_id text not null references oidc_clients(client_id),
        secret_digest text not null check (secret_digest like 'scrypt$%'),
        status text not null check (status in ('active', 'retiring', 'revoked')),
        created_at timestamptz not null default now(),
        expires_at timestamptz,
        revoked_at timestamptz,
        version integer not null default 1 check (version > 0),
        check (
          (status = 'active' and expires_at is null and revoked_at is null) or
          (status = 'retiring' and expires_at is not null and revoked_at is null) or
          (status = 'revoked' and revoked_at is not null)
        )
      );
    `);
    await this.pool.query(`
      create unique index if not exists uq_oidc_client_secrets_active
      on oidc_client_secrets (client_id) where status = 'active';
      create index if not exists idx_oidc_client_secrets_client_created
      on oidc_client_secrets (client_id, created_at desc);
      create index if not exists idx_oidc_client_secrets_expires
      on oidc_client_secrets (expires_at) where status = 'retiring';
      create index if not exists idx_oidc_client_secrets_usable
      on oidc_client_secrets (client_id, status, expires_at)
      where status in ('active', 'retiring');
    `);
    await this.pool.query(`
      create table if not exists oidc_client_revisions (
        revision_id bigserial primary key,
        client_id text not null references oidc_clients(client_id),
        revision_number integer not null check (revision_number > 0),
        review_status text not null check (review_status in ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
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
      create index if not exists idx_oidc_clients_project_updated
      on oidc_clients (project_id, updated_at desc);
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
      create table if not exists project_audit_logs (
        id bigserial primary key,
        project_id text not null references projects(project_id),
        client_id text,
        revision_id bigint,
        revision_number integer,
        secret_id text,
        actor_subject_id text,
        target_subject_id text,
        action text not null,
        changed_fields jsonb not null default '[]'::jsonb,
        previous_client_status text,
        new_client_status text,
        previous_revision_status text,
        new_revision_status text,
        previous_role text,
        new_role text,
        reason text,
        source_ip text,
        created_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      create index if not exists idx_project_audit_logs_project_created
      on project_audit_logs (project_id, id desc);
      create index if not exists idx_project_audit_logs_client_created
      on project_audit_logs (client_id, id desc) where client_id is not null;
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
        client_id_hash text,
        authorization_generation integer,
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
      add column if not exists client_id_hash text,
      add column if not exists authorization_generation integer,
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
      create index if not exists idx_oidc_artifacts_client_id_hash_kind
      on oidc_artifacts (client_id_hash, kind);
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
    await this.pool.query(`
      create table if not exists app_settings (
        key text primary key,
        value_ciphertext text not null,
        version integer not null default 1 check (version > 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      create table if not exists app_settings_audit_logs (
        id bigserial primary key,
        setting_key text not null,
        actor_subject_id text,
        action text not null,
        changed_fields jsonb not null default '[]'::jsonb,
        previous_values jsonb not null default '{}'::jsonb,
        new_values jsonb not null default '{}'::jsonb,
        secrets_replaced jsonb not null default '{}'::jsonb,
        previous_version integer not null check (previous_version >= 0),
        new_version integer not null check (new_version > 0),
        source_ip text,
        created_at timestamptz not null default now()
      );
    `);
    await this.pool.query(`
      create index if not exists idx_app_settings_audit_key_created
      on app_settings_audit_logs (setting_key, id desc);
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
      "project_id",
      "created_by_subject_id",
      "client_type",
      "lifecycle_status",
      "active_revision_id",
      "authorization_generation",
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

export type PersistenceModules = {
  runtime: PersistenceRuntime;
  identity: IdentityRepository;
  projects: ProjectRepository;
  clients: OidcClientRepository;
  sessions: ManagementSessionRepository;
  artifacts: OidcArtifactRepository;
  signingKeys: SigningKeyRepository;
  settings: AppSettingsRepository;
  jwkCipher: JwkCipherService;
};

export async function createPersistence(
  config: StaticConfig,
): Promise<PersistenceModules> {
  const runtime = new PersistenceRuntimeImpl(config);
  await runtime.init();
  return {
    runtime,
    identity: runtime.identityRepository,
    projects: runtime.projectRepository,
    clients: runtime.oidcClientRepository,
    sessions: runtime.managementSessionRepository,
    artifacts: runtime.oidcArtifactRepository,
    signingKeys: runtime.signingKeyRepository,
    settings: runtime.appSettingsRepository,
    jwkCipher: runtime.jwkCipherService,
  };
}
