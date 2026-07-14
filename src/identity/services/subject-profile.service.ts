import type { IdentityStore } from "../store.js";
import type { SubjectProfileRecord } from "../types.js";

type EnsureProfileInput = {
  subjectId: string;
  preferredUsername: string;
  displayName: string;
};

export class SubjectProfileService {
  constructor(private readonly store: IdentityStore) {}

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
      updatedAt: new Date().toISOString(),
      ...existing,
      ...merge(existing),
    };
    return this.store.upsertProfile(next);
  }

  async ensureProfile(
    input: EnsureProfileInput,
  ): Promise<SubjectProfileRecord> {
    return this.updateProfile(input.subjectId, (existing) => ({
      preferredUsername: existing?.preferredUsername ?? input.preferredUsername,
      displayName: existing?.displayName ?? input.displayName,
    }));
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
}
