import type {
  AuthenticatedPrincipal,
  SubjectIdentityRecord,
  SubjectProfileRecord,
  SubjectRecord
} from "@cqut/identity-core";
import { Pool } from "pg";
import type { OidcOpConfig } from "../config.js";
import {
  ensureArtifactCleanupJob,
  ArtifactCleanupConfigurationError
} from "./artifact-cleanup.scheduler.js";
import type {
  OidcClientRecord,
  OidcPersistence,
  OidcSigningKeyRecord,
  PendingInteractionLogin
} from "./contracts.js";
import { IdentityRepositoryImpl } from "./identity.repository.js";
import { JwkCipherServiceImpl } from "./jwk-cipher.service.js";
import { OidcArtifactRepositoryImpl } from "./oidc-artifact.repository.js";
import { OidcClientRepositoryImpl } from "./oidc-client.repository.js";
import { SigningKeyRepositoryImpl } from "./signing-key.repository.js";

export class OidcPersistenceImpl implements OidcPersistence {
  private readonly logger = console;
  private pool: Pool | undefined;
  private readonly jwkCipherService: JwkCipherServiceImpl;
  private readonly identityRepository: IdentityRepositoryImpl;
  private readonly oidcClientRepository: OidcClientRepositoryImpl;
  private readonly oidcArtifactRepository: OidcArtifactRepositoryImpl;
  private readonly signingKeyRepository: SigningKeyRepositoryImpl;

  constructor(private readonly config: OidcOpConfig) {
    const poolProvider = () => this.pool;
    this.jwkCipherService = new JwkCipherServiceImpl(config.keyEncryptionSecret);
    this.identityRepository = new IdentityRepositoryImpl(poolProvider);
    this.oidcClientRepository = new OidcClientRepositoryImpl(poolProvider);
    this.oidcArtifactRepository = new OidcArtifactRepositoryImpl(
      poolProvider,
      config.interactionTtlSeconds,
      {
        enabled: config.artifactOpportunisticCleanupEnabled,
        sampleRate: config.artifactOpportunisticCleanupSampleRate,
        batchSize: config.artifactOpportunisticCleanupBatchSize,
        minIntervalSeconds: config.artifactOpportunisticCleanupIntervalSeconds
      }
    );
    this.signingKeyRepository = new SigningKeyRepositoryImpl(poolProvider, this.jwkCipherService);
  }

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
      await ensureArtifactCleanupJob(this.pool, {
        enabled: this.config.artifactCleanupEnabled,
        schedule: this.config.artifactCleanupCron
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

  async findSubject(subjectId: string): Promise<SubjectRecord | null> {
    return this.identityRepository.findSubject(subjectId);
  }

  async findIdentity(provider: string, identityKey: string): Promise<SubjectIdentityRecord | null> {
    return this.identityRepository.findIdentity(provider, identityKey);
  }

  async createSubjectWithIdentity(
    subject: SubjectRecord,
    identity: SubjectIdentityRecord
  ): Promise<SubjectIdentityRecord> {
    return this.identityRepository.createSubjectWithIdentity(subject, identity);
  }

  async updateIdentity(
    provider: string,
    identityKey: string,
    patch: Pick<SubjectIdentityRecord, "schoolUid" | "currentStudentStatus" | "school" | "updatedAt">
  ): Promise<SubjectIdentityRecord> {
    return this.identityRepository.updateIdentity(provider, identityKey, patch);
  }

  async getProfile(subjectId: string): Promise<SubjectProfileRecord | null> {
    return this.identityRepository.getProfile(subjectId);
  }

  async upsertProfile(profile: SubjectProfileRecord): Promise<SubjectProfileRecord> {
    return this.identityRepository.upsertProfile(profile);
  }

  async findPrincipalBySubjectId(subjectId: string): Promise<AuthenticatedPrincipal | null> {
    return this.identityRepository.findPrincipalBySubjectId(subjectId);
  }

  async upsertOidcClient(client: OidcClientRecord): Promise<OidcClientRecord> {
    return this.oidcClientRepository.upsertOidcClient(client);
  }

  async findOidcClient(clientId: string): Promise<OidcClientRecord | null> {
    return this.oidcClientRepository.findOidcClient(clientId);
  }

  async listActiveOidcClients(): Promise<OidcClientRecord[]> {
    return this.oidcClientRepository.listActiveOidcClients();
  }

  async upsertArtifact(
    id: string,
    kind: string,
    payload: Record<string, unknown>,
    expiresIn: number
  ): Promise<void> {
    return this.oidcArtifactRepository.upsertArtifact(id, kind, payload, expiresIn);
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

  async findArtifactByUid(uid: string): Promise<Record<string, unknown> | undefined> {
    return this.oidcArtifactRepository.findArtifactByUid(uid);
  }

  async findArtifactByUserCode(userCode: string): Promise<Record<string, unknown> | undefined> {
    return this.oidcArtifactRepository.findArtifactByUserCode(userCode);
  }

  async revokeArtifactsByGrantId(grantId: string): Promise<void> {
    return this.oidcArtifactRepository.revokeArtifactsByGrantId(grantId);
  }

  async saveInteractionLogin(uid: string, value: PendingInteractionLogin): Promise<void> {
    return this.oidcArtifactRepository.saveInteractionLogin(uid, value);
  }

  async getInteractionLogin(uid: string): Promise<PendingInteractionLogin | undefined> {
    return this.oidcArtifactRepository.getInteractionLogin(uid);
  }

  async deleteInteractionLogin(uid: string): Promise<void> {
    return this.oidcArtifactRepository.deleteInteractionLogin(uid);
  }

  async upsertSigningKey(key: OidcSigningKeyRecord): Promise<OidcSigningKeyRecord> {
    return this.signingKeyRepository.upsertSigningKey(key);
  }

  async listSigningKeys(
    statuses: Array<OidcSigningKeyRecord["status"]> = ["active", "retiring"]
  ): Promise<OidcSigningKeyRecord[]> {
    return this.signingKeyRepository.listSigningKeys(statuses);
  }

  async loadPrivateSigningJwks(statuses: Array<OidcSigningKeyRecord["status"]> = ["active", "retiring"]) {
    return this.signingKeyRepository.loadPrivateSigningJwks(statuses);
  }

  encryptPrivateJwk(jwk: JsonWebKey) {
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
      create index if not exists idx_oidc_artifacts_expires_at
      on oidc_artifacts (expires_at);
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
}
