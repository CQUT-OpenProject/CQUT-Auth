import type { OidcStore } from "../persistence/store.js";

export function createAdapter(store: OidcStore) {
  return class PostgresAdapter {
    readonly modelName: string;

    constructor(modelName: string) {
      this.modelName = modelName;
    }

    async upsert(id: string, payload: Record<string, unknown>, expiresIn: number) {
      await store.upsertArtifact(`${this.modelName}:${id}`, this.modelName, payload, expiresIn);
    }

    async find(id: string) {
      return store.findArtifact(`${this.modelName}:${id}`);
    }

    async findByUid(uid: string) {
      const payload = await store.findArtifactByUid(uid);
      if (payload && payload["kind"] === this.modelName) {
        return payload;
      }
      return payload;
    }

    async findByUserCode(userCode: string) {
      return store.findArtifactByUserCode(userCode);
    }

    async destroy(id: string) {
      await store.destroyArtifact(`${this.modelName}:${id}`);
    }

    async consume(id: string) {
      await store.consumeArtifact(`${this.modelName}:${id}`);
    }

    async revokeByGrantId(grantId: string) {
      await store.revokeArtifactsByGrantId(grantId);
    }
  };
}
