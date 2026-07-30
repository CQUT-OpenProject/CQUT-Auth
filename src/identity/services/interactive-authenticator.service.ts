import type { IdentityStore } from "../store.js";
import type {
  AuthenticatedPrincipal,
  CampusVerifierProvider,
  InteractiveLoginInput,
  SubjectIdentityRecord,
  SubjectProfileRecord,
  VerificationIdentity,
} from "../types.js";
import { hasSafeCredentialLengths } from "../types.js";
import { IdentityCoreError } from "../errors.js";
import { randomId } from "../../utils.js";

export class InteractiveAuthenticatorService {
  constructor(
    private readonly providers: Map<string, CampusVerifierProvider>,
    private readonly store: IdentityStore,
    private readonly createSubjectId: () => string = () => randomId("subj"),
  ) {}

  async authenticate(
    input: InteractiveLoginInput,
  ): Promise<AuthenticatedPrincipal> {
    if (!input.account || !input.password) {
      throw new IdentityCoreError(
        "invalid_request",
        "missing account or password",
      );
    }
    if (!hasSafeCredentialLengths(input.account, input.password)) {
      throw new IdentityCoreError(
        "invalid_request",
        "invalid credential length",
      );
    }
    const provider = this.providers.get(input.provider);
    if (!provider) {
      throw new IdentityCoreError(
        "unknown_provider",
        `unknown auth provider: ${input.provider}`,
      );
    }
    const identity = await provider.verifyCredentials({
      account: input.account,
      password: input.password,
    });
    const linkedIdentity = await this.linkVerifiedIdentity(
      input.provider,
      identity,
    );
    const profile = await this.ensureProfile({
      subjectId: linkedIdentity.subjectId,
      preferredUsername: linkedIdentity.schoolUid,
      displayName: `User-${linkedIdentity.schoolUid}`,
    });
    const subject = await this.store.findSubject(linkedIdentity.subjectId);
    if (!subject || subject.status !== "active") {
      throw new IdentityCoreError("verification_failed", "subject is inactive");
    }
    return {
      subjectId: linkedIdentity.subjectId,
      schoolUid: linkedIdentity.schoolUid,
      school: linkedIdentity.school,
      studentStatus: linkedIdentity.currentStudentStatus,
      identitySource: linkedIdentity.provider,
      identityKey: linkedIdentity.identityKey,
      emailVerified: profile.emailVerified,
      preferredUsername: profile.preferredUsername ?? linkedIdentity.schoolUid,
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
    };
  }

  async setEmail(
    subjectId: string,
    email: string,
  ): Promise<SubjectProfileRecord> {
    return this.updateProfile(subjectId, () => ({
      email,
      emailVerified: false,
    }));
  }

  async setVerifiedEmail(
    subjectId: string,
    email: string,
  ): Promise<SubjectProfileRecord> {
    return this.updateProfile(subjectId, () => ({
      email,
      emailVerified: true,
    }));
  }

  private async linkVerifiedIdentity(
    provider: string,
    identity: VerificationIdentity,
  ): Promise<SubjectIdentityRecord> {
    const identityKey =
      identity.identityHash ?? `${provider}:${identity.schoolUid}`;
    const now = new Date().toISOString();
    const existing = await this.store.findIdentity(provider, identityKey);
    if (existing) {
      return this.store.updateIdentity(provider, identityKey, {
        schoolUid: identity.schoolUid,
        currentStudentStatus: identity.studentStatus,
        school: identity.school,
        updatedAt: now,
      });
    }
    const subjectId = this.createSubjectId();
    return this.store.createSubjectWithIdentity(
      {
        subjectId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        subjectId,
        provider,
        schoolUid: identity.schoolUid,
        identityKey,
        currentStudentStatus: identity.studentStatus,
        school: identity.school,
        createdAt: now,
        updatedAt: now,
      },
    );
  }

  private async ensureProfile(input: {
    subjectId: string;
    preferredUsername: string;
    displayName: string;
  }): Promise<SubjectProfileRecord> {
    return this.updateProfile(input.subjectId, (existing) => ({
      preferredUsername: existing?.preferredUsername ?? input.preferredUsername,
      displayName: existing?.displayName ?? input.displayName,
    }));
  }

  private async updateProfile(
    subjectId: string,
    merge: (
      existing: SubjectProfileRecord | null,
    ) => Partial<SubjectProfileRecord>,
  ): Promise<SubjectProfileRecord> {
    const existing = await this.store.getProfile(subjectId);
    const next: SubjectProfileRecord = {
      subjectId,
      emailVerified: existing?.emailVerified ?? false,
      ...existing,
      ...merge(existing),
      updatedAt: new Date().toISOString(),
    };
    return this.store.upsertProfile(next);
  }
}
