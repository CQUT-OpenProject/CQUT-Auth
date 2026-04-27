import type { SubjectIdentityRecord } from "../types.js";
import type { LinkIdentityInput, IdentityStore } from "../store.js";
import { randomId } from "../utils.js";

export class IdentityLinkService {
  constructor(
    private readonly store: IdentityStore,
    private readonly createSubjectId: () => string = () => randomId("subj")
  ) {}

  async linkVerifiedIdentity(input: LinkIdentityInput): Promise<SubjectIdentityRecord> {
    const identityKey = input.identity.identityHash ?? `${input.provider}:${input.identity.schoolUid}`;
    const now = new Date().toISOString();
    const existing = await this.store.findIdentity(input.provider, identityKey);
    if (existing) {
      return this.store.updateIdentity(input.provider, identityKey, {
        schoolUid: input.identity.schoolUid,
        currentStudentStatus: input.identity.studentStatus,
        school: input.identity.school,
        updatedAt: now
      });
    }

    const subjectId = this.createSubjectId();
    return this.store.createSubjectWithIdentity(
      {
        subjectId,
        status: "active",
        createdAt: now,
        updatedAt: now
      },
      {
        subjectId,
        provider: input.provider,
        schoolUid: input.identity.schoolUid,
        identityKey,
        currentStudentStatus: input.identity.studentStatus,
        school: input.identity.school,
        createdAt: now,
        updatedAt: now
      }
    );
  }
}
