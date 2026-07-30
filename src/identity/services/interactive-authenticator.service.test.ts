import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveAuthenticatorService } from "./interactive-authenticator.service.js";
import type { IdentityStore } from "../store.js";
import type { SubjectProfileRecord } from "../types.js";

class MemoryIdentityStore implements Partial<IdentityStore> {
  private readonly profiles = new Map<string, SubjectProfileRecord>();

  async getProfile(subjectId: string): Promise<SubjectProfileRecord | null> {
    return this.profiles.get(subjectId) ?? null;
  }

  async upsertProfile(profile: SubjectProfileRecord): Promise<SubjectProfileRecord> {
    this.profiles.set(profile.subjectId, profile);
    return profile;
  }
}

test("setEmail updates profile updatedAt timestamp on existing profiles", async () => {
  const store = new MemoryIdentityStore();
  const service = new InteractiveAuthenticatorService(
    new Map(),
    store as unknown as IdentityStore,
  );

  const oldTime = "2020-01-01T00:00:00.000Z";
  await store.upsertProfile({
    subjectId: "subj_1",
    preferredUsername: "user1",
    displayName: "User 1",
    emailVerified: false,
    updatedAt: oldTime,
  });

  const updated = await service.setEmail("subj_1", "user1@example.com");
  assert.equal(updated.email, "user1@example.com");
  assert.notEqual(updated.updatedAt, oldTime);
  assert.ok(Date.parse(updated.updatedAt) > Date.parse(oldTime));
});
