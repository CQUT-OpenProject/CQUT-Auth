import type {
  AuthenticatedPrincipal,
  IdentityStore,
  SubjectIdentityRecord,
  SubjectProfileRecord,
  SubjectRecord
} from "@cqut/identity-core";
import type { OidcScope } from "@cqut/shared";

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

export interface IdentityRepository extends IdentityStore {
  findSubject(subjectId: string): Promise<SubjectRecord | null>;
  findIdentity(provider: string, identityKey: string): Promise<SubjectIdentityRecord | null>;
  createSubjectWithIdentity(
    subject: SubjectRecord,
    identity: SubjectIdentityRecord
  ): Promise<SubjectIdentityRecord>;
  updateIdentity(
    provider: string,
    identityKey: string,
    patch: Pick<SubjectIdentityRecord, "schoolUid" | "currentStudentStatus" | "school" | "updatedAt">
  ): Promise<SubjectIdentityRecord>;
  getProfile(subjectId: string): Promise<SubjectProfileRecord | null>;
  upsertProfile(profile: SubjectProfileRecord): Promise<SubjectProfileRecord>;
  findPrincipalBySubjectId(subjectId: string): Promise<AuthenticatedPrincipal | null>;
}

export interface OidcClientRepository {
  upsertOidcClient(client: OidcClientRecord): Promise<OidcClientRecord>;
  findOidcClient(clientId: string): Promise<OidcClientRecord | null>;
  listActiveOidcClients(): Promise<OidcClientRecord[]>;
}

export interface OidcArtifactRepository {
  upsertArtifact(
    id: string,
    kind: string,
    payload: Record<string, unknown>,
    expiresIn: number
  ): Promise<void>;
  findArtifact(id: string): Promise<Record<string, unknown> | undefined>;
  destroyArtifact(id: string): Promise<void>;
  consumeArtifact(id: string): Promise<void>;
  findArtifactByUid(uid: string): Promise<Record<string, unknown> | undefined>;
  findArtifactByUserCode(userCode: string): Promise<Record<string, unknown> | undefined>;
  revokeArtifactsByGrantId(grantId: string): Promise<void>;
  saveInteractionLogin(uid: string, value: PendingInteractionLogin): Promise<void>;
  getInteractionLogin(uid: string): Promise<PendingInteractionLogin | undefined>;
  deleteInteractionLogin(uid: string): Promise<void>;
}

export interface SigningKeyRepository {
  upsertSigningKey(key: OidcSigningKeyRecord): Promise<OidcSigningKeyRecord>;
  listSigningKeys(statuses?: Array<OidcSigningKeyRecord["status"]>): Promise<OidcSigningKeyRecord[]>;
  loadPrivateSigningJwks(
    statuses?: Array<OidcSigningKeyRecord["status"]>
  ): Promise<Array<JsonWebKey & { kid: string; alg: string; use: string }>>;
}

export interface JwkCipherService {
  encryptPrivateJwk(jwk: JsonWebKey): string;
}

export interface PersistenceRuntime {
  init(): Promise<void>;
  close(): Promise<void>;
  hasDatabase(): boolean;
  checkReadiness(): Promise<boolean>;
}

export interface OidcPersistence
  extends PersistenceRuntime,
    IdentityRepository,
    OidcClientRepository,
    OidcArtifactRepository,
    SigningKeyRepository,
    JwkCipherService {}
