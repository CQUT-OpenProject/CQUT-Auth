import type {
  SubjectIdentityRecord,
  SubjectProfileRecord,
  SubjectRecord,
  VerificationIdentity
} from "./types.js";

export interface IdentityStore {
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
}

export type LinkIdentityInput = {
  provider: string;
  identity: VerificationIdentity;
};
