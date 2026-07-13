import type { IdentityStore } from "../store.js";
import type { SubjectProfileRecord } from "../types.js";

type EnsureProfileInput = {
  subjectId: string;
  preferredUsername: string;
  displayName: string;
};

export class SubjectProfileService {
  constructor(private readonly store: IdentityStore) {}

  async ensureProfile(input: EnsureProfileInput): Promise<SubjectProfileRecord> {
    const existing = await this.store.getProfile(input.subjectId);
    const next: SubjectProfileRecord = {
      subjectId: input.subjectId,
      preferredUsername: existing?.preferredUsername ?? input.preferredUsername,
      displayName: existing?.displayName ?? input.displayName,
      emailVerified: existing?.emailVerified ?? false,
      updatedAt: new Date().toISOString(),
      ...(existing?.email ? { email: existing.email } : {})
    };
    return this.store.upsertProfile(next);
  }

  async setEmail(subjectId: string, email: string): Promise<SubjectProfileRecord> {
    const existing = await this.store.getProfile(subjectId);
    return this.store.upsertProfile({
      subjectId,
      ...(existing?.preferredUsername ? { preferredUsername: existing.preferredUsername } : {}),
      ...(existing?.displayName ? { displayName: existing.displayName } : {}),
      email,
      emailVerified: false,
      updatedAt: new Date().toISOString()
    });
  }

  async setVerifiedEmail(subjectId: string, email: string): Promise<SubjectProfileRecord> {
    const existing = await this.store.getProfile(subjectId);
    return this.store.upsertProfile({
      subjectId,
      ...(existing?.preferredUsername ? { preferredUsername: existing.preferredUsername } : {}),
      ...(existing?.displayName ? { displayName: existing.displayName } : {}),
      email,
      emailVerified: true,
      updatedAt: new Date().toISOString()
    });
  }
}
