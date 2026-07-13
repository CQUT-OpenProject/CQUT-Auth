import type {
  AuthenticatedPrincipal,
  IdentityStore,
  SubjectIdentityRecord,
  SubjectProfileRecord,
  SubjectRecord,
} from "../identity/index.js";
import type { OidcScope } from "../shared/oidc-contracts.js";

export type ClientLifecycleStatus = "draft" | "active" | "disabled";
export type ClientSecretStatus = "active" | "retiring" | "revoked";
export type ClientRevisionStatus =
  | "draft"
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled";

export type OidcClientRecord = {
  clientId: string;
  displayName: string;
  description: string;
  ownerSubjectId: string | null;
  clientType: "web" | "spa";
  autoConsent: boolean;
  lifecycleStatus: ClientLifecycleStatus;
  activeRevisionId: number | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type OidcClientSecretRecord = {
  secretId: string;
  clientId: string;
  secretDigest: string;
  status: ClientSecretStatus;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  version: number;
};

export type OidcClientRevisionRecord = {
  revisionId: number;
  clientId: string;
  revisionNumber: number;
  status: ClientRevisionStatus;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopeWhitelist: OidcScope[];
  rejectionReason?: string | undefined;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type ManagedOidcClientRecord = {
  client: OidcClientRecord;
  secrets: OidcClientSecretRecord[];
  activeRevision: OidcClientRevisionRecord | null;
  proposedRevision: OidcClientRevisionRecord | null;
};

export type RevisionMutationResult =
  | { status: "updated"; client: ManagedOidcClientRecord }
  | { status: "version_conflict" }
  | { status: "pending_quota_exceeded" };

export type ActiveOidcClientRecord = OidcClientRecord & {
  activeRevisionId: number;
  activeRevision: OidcClientRevisionRecord;
  applicationType: "web";
  tokenEndpointAuthMethod: "client_secret_basic" | "none";
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scopeWhitelist: OidcScope[];
  requirePkce: boolean;
  allowRefreshTokenForPublicClient: boolean;
  clientSecretDigests: string[];
};

export type ClientSecurityMutationResult =
  | { status: "updated"; client: ManagedOidcClientRecord }
  | { status: "version_conflict" }
  | { status: "secret_limit_exceeded" }
  | { status: "secret_not_found" };

export type OidcClientAuditAction =
  | "client.initialized"
  | "client.created"
  | "client.updated"
  | "client.disabled"
  | "client.secret_generated"
  | "client.secret_rotated"
  | "client.secret_revoked"
  | "client.authorizations_revoked"
  | "client.emergency_disabled"
  | "revision.created"
  | "revision.updated"
  | "revision.submitted"
  | "revision.withdrawn"
  | "revision.approved"
  | "revision.rejected"
  | "revision.cancelled"
  | "revision.activated";

export type OidcClientAuditRecord = {
  id?: number;
  clientId: string;
  revisionId?: number | undefined;
  revisionNumber?: number | undefined;
  secretId?: string | undefined;
  actorSubjectId: string | null;
  action: OidcClientAuditAction;
  changedFields: string[];
  previousClientStatus?: ClientLifecycleStatus | undefined;
  newClientStatus?: ClientLifecycleStatus | undefined;
  previousRevisionStatus?: ClientRevisionStatus | undefined;
  newRevisionStatus?: ClientRevisionStatus | undefined;
  reason?: string | undefined;
  sourceIp?: string | undefined;
  createdAt: string;
};

export type ManagementSessionRecord = {
  tokenHash: string;
  subjectId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type PendingInteractionLogin = {
  principal: AuthenticatedPrincipal;
  authTime: number;
  emailVerification?: {
    email: string;
    codeHash: string;
    expiresAt: number;
    attempts: number;
    nextResendAt: number;
  };
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

export interface IdentityRepository extends IdentityStore {
  findSubject(subjectId: string): Promise<SubjectRecord | null>;
  findIdentity(
    provider: string,
    identityKey: string,
  ): Promise<SubjectIdentityRecord | null>;
  createSubjectWithIdentity(
    subject: SubjectRecord,
    identity: SubjectIdentityRecord,
  ): Promise<SubjectIdentityRecord>;
  updateIdentity(
    provider: string,
    identityKey: string,
    patch: Pick<
      SubjectIdentityRecord,
      "schoolUid" | "currentStudentStatus" | "school" | "updatedAt"
    >,
  ): Promise<SubjectIdentityRecord>;
  getProfile(subjectId: string): Promise<SubjectProfileRecord | null>;
  upsertProfile(profile: SubjectProfileRecord): Promise<SubjectProfileRecord>;
  findPrincipalBySubjectId(
    subjectId: string,
  ): Promise<AuthenticatedPrincipal | null>;
}

export interface OidcClientRepository {
  upsertOidcClient(
    client: ActiveOidcClientRecord,
  ): Promise<ActiveOidcClientRecord>;
  countOidcClients(): Promise<number>;
  initializeOidcClientsIfEmpty(
    clients: ActiveOidcClientRecord[],
    audits: OidcClientAuditRecord[],
  ): Promise<{ imported: boolean; count: number }>;
  createOidcClient(
    client: OidcClientRecord,
    revision: OidcClientRevisionRecord,
    secret: OidcClientSecretRecord | undefined,
    audits: OidcClientAuditRecord[],
    ownerLimits?: {
      maxNonDisabledClients: number;
      maxPendingClients: number;
    },
  ): Promise<ManagedOidcClientRecord | null>;
  updateOidcClientMetadata(
    clientId: string,
    patch: Pick<OidcClientRecord, "displayName" | "description" | "updatedAt">,
    expectedVersion: number,
    audit: OidcClientAuditRecord,
  ): Promise<ManagedOidcClientRecord | null>;
  saveOidcClientRevision(
    clientId: string,
    revision: OidcClientRevisionRecord,
    expectedRevisionId: number | null,
    expectedRevisionVersion: number | null,
    audits: OidcClientAuditRecord[],
    maxPendingClients?: number,
  ): Promise<RevisionMutationResult>;
  transitionOidcClientRevision(
    clientId: string,
    revisionId: number,
    expectedVersion: number,
    nextStatus: ClientRevisionStatus,
    reason: string | undefined,
    audit: OidcClientAuditRecord,
    maxPendingClients?: number,
  ): Promise<RevisionMutationResult>;
  approveOidcClientRevision(
    clientId: string,
    revisionId: number,
    expectedVersion: number,
    audits: OidcClientAuditRecord[],
  ): Promise<ManagedOidcClientRecord | null>;
  disableOidcClient(
    clientId: string,
    expectedVersion: number,
    updatedAt: string,
    audits: OidcClientAuditRecord[],
  ): Promise<ManagedOidcClientRecord | null>;
  rotateOidcClientSecret(
    clientId: string,
    secret: OidcClientSecretRecord,
    expectedClientVersion: number,
    gracePeriodSeconds: number,
    audit: OidcClientAuditRecord,
  ): Promise<ClientSecurityMutationResult>;
  revokeOidcClientSecret(
    clientId: string,
    secretId: string,
    expectedClientVersion: number,
    expectedSecretVersion: number,
    updatedAt: string,
    audit: OidcClientAuditRecord,
  ): Promise<ClientSecurityMutationResult>;
  revokeOidcClientAuthorizations(
    clientId: string,
    expectedClientVersion: number,
    updatedAt: string,
    audit: OidcClientAuditRecord,
  ): Promise<ManagedOidcClientRecord | null>;
  findManagedOidcClient(
    clientId: string,
  ): Promise<ManagedOidcClientRecord | null>;
  findOidcClient(clientId: string): Promise<ActiveOidcClientRecord | null>;
  listActiveOidcClients(): Promise<ActiveOidcClientRecord[]>;
  listOidcClientsByOwner(
    ownerSubjectId: string,
  ): Promise<ManagedOidcClientRecord[]>;
  listOidcClients(): Promise<ManagedOidcClientRecord[]>;
  listPendingOidcClients(): Promise<ManagedOidcClientRecord[]>;
  listOidcClientAuditLogs(clientId?: string): Promise<OidcClientAuditRecord[]>;
}

export interface ManagementSessionRepository {
  createManagementSession(session: ManagementSessionRecord): Promise<void>;
  findManagementSession(
    tokenHash: string,
  ): Promise<ManagementSessionRecord | null>;
  touchManagementSession(tokenHash: string, lastSeenAt: string): Promise<void>;
  deleteManagementSession(tokenHash: string): Promise<void>;
  deleteExpiredManagementSessions(now: string): Promise<number>;
}

export interface OidcArtifactRepository {
  upsertArtifact(
    id: string,
    kind: string,
    payload: Record<string, unknown>,
    expiresIn: number,
  ): Promise<void>;
  findArtifact(id: string): Promise<Record<string, unknown> | undefined>;
  destroyArtifact(id: string): Promise<void>;
  consumeArtifact(id: string): Promise<void>;
  findArtifactByUid(
    uid: string,
    kind?: string,
  ): Promise<Record<string, unknown> | undefined>;
  findArtifactByUserCode(
    userCode: string,
  ): Promise<Record<string, unknown> | undefined>;
  revokeArtifactsByGrantId(grantId: string): Promise<void>;
  revokeArtifactsByClientId(clientId: string): Promise<void>;
  saveInteractionLogin(
    uid: string,
    value: PendingInteractionLogin,
  ): Promise<void>;
  getInteractionLogin(
    uid: string,
  ): Promise<PendingInteractionLogin | undefined>;
  deleteInteractionLogin(uid: string): Promise<void>;
}

export interface SigningKeyRepository {
  upsertSigningKey(key: OidcSigningKeyRecord): Promise<OidcSigningKeyRecord>;
  listSigningKeys(
    statuses?: Array<OidcSigningKeyRecord["status"]>,
  ): Promise<OidcSigningKeyRecord[]>;
  loadPrivateSigningJwks(
    statuses?: Array<OidcSigningKeyRecord["status"]>,
  ): Promise<Array<JsonWebKey & { kid: string; alg: string; use: string }>>;
}

export interface JwkCipherService {
  encryptPrivateJwk(jwk: JsonWebKey): Promise<string>;
}

export interface PersistenceRuntime {
  init(): Promise<void>;
  close(): Promise<void>;
  hasDatabase(): boolean;
  checkReadiness(): Promise<boolean>;
}

export interface OidcPersistence
  extends
    PersistenceRuntime,
    IdentityRepository,
    OidcClientRepository,
    ManagementSessionRepository,
    OidcArtifactRepository,
    SigningKeyRepository,
    JwkCipherService {}
