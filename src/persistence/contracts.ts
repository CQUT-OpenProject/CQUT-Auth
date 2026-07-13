import type {
  AuthenticatedPrincipal,
  IdentityStore,
  SubjectIdentityRecord,
  SubjectProfileRecord,
  SubjectRecord,
} from "../identity/index.js";
import type { OidcScope } from "../shared/oidc-contracts.js";

export type OidcClientRecord = {
  clientId: string;
  clientSecretDigest: string | undefined;
  displayName: string;
  description: string;
  ownerSubjectId: string | null;
  applicationType: "web";
  tokenEndpointAuthMethod: "client_secret_basic" | "none";
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scopeWhitelist: OidcScope[];
  requirePkce: boolean;
  allowRefreshTokenForPublicClient: boolean;
  autoConsent: boolean;
  status: "draft" | "pending" | "active" | "disabled" | "rejected";
  rejectionReason?: string | undefined;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type OidcClientAuditAction =
  | "client.initialized"
  | "client.created"
  | "client.updated"
  | "client.submitted"
  | "client.approved"
  | "client.rejected"
  | "client.disabled"
  | "client.secret_generated";

export type OidcClientAuditRecord = {
  id?: number;
  clientId: string;
  actorSubjectId: string | null;
  action: OidcClientAuditAction;
  changedFields: string[];
  previousStatus?: OidcClientRecord["status"] | undefined;
  newStatus?: OidcClientRecord["status"] | undefined;
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
  upsertOidcClient(client: OidcClientRecord): Promise<OidcClientRecord>;
  countOidcClients(): Promise<number>;
  initializeOidcClientsIfEmpty(
    clients: OidcClientRecord[],
    audits: OidcClientAuditRecord[],
  ): Promise<{ imported: boolean; count: number }>;
  createOidcClient(
    client: OidcClientRecord,
    audits: OidcClientAuditRecord[],
    ownerLimits?: {
      maxNonDisabledClients: number;
      maxPendingClients: number;
    },
  ): Promise<OidcClientRecord | null>;
  updateOidcClient(
    client: OidcClientRecord,
    expectedVersion: number,
    audit: OidcClientAuditRecord,
  ): Promise<OidcClientRecord | null>;
  findOidcClient(clientId: string): Promise<OidcClientRecord | null>;
  listActiveOidcClients(): Promise<OidcClientRecord[]>;
  listOidcClientsByOwner(ownerSubjectId: string): Promise<OidcClientRecord[]>;
  listOidcClients(): Promise<OidcClientRecord[]>;
  listPendingOidcClients(): Promise<OidcClientRecord[]>;
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
