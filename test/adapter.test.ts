import assert from "node:assert/strict";
import test from "node:test";
import { createAdapter } from "../src/oidc/adapter.js";
import type { OidcClientRecord, OidcPersistence, PendingInteractionLogin } from "../src/persistence/contracts.js";

function createMockStore(
  findByUidImpl: (uid: string, kind?: string) => Promise<Record<string, unknown> | undefined>,
  findOidcClientImpl: (clientId: string) => Promise<OidcClientRecord | null> = async () => null
): Pick<
  OidcPersistence,
  | "upsertArtifact"
  | "findArtifact"
  | "destroyArtifact"
  | "consumeArtifact"
  | "findArtifactByUid"
  | "findArtifactByUserCode"
  | "revokeArtifactsByGrantId"
  | "saveInteractionLogin"
  | "getInteractionLogin"
  | "deleteInteractionLogin"
  | "findOidcClient"
> {
  return {
    async upsertArtifact() {},
    async findArtifact() {
      return undefined;
    },
    async destroyArtifact() {},
    async consumeArtifact() {},
    async findArtifactByUid(uid: string, kind?: string) {
      return findByUidImpl(uid, kind);
    },
    async findArtifactByUserCode() {
      return undefined;
    },
    async revokeArtifactsByGrantId() {},
    async saveInteractionLogin(_uid: string, _value: PendingInteractionLogin) {},
    async getInteractionLogin() {
      return undefined;
    },
    async deleteInteractionLogin() {},
    async findOidcClient(clientId: string) {
      return findOidcClientImpl(clientId);
    }
  };
}

test("adapter findByUid requests uid with current model kind", async () => {
  const calls: Array<{ uid: string; kind: string | undefined }> = [];
  const store = createMockStore(async (uid, kind) => {
    calls.push({ uid, kind });
    return undefined;
  });
  const Adapter = createAdapter(store);
  const sessionAdapter = new Adapter("Session");

  await sessionAdapter.findByUid("shared-uid");

  assert.deepEqual(calls, [{ uid: "shared-uid", kind: "Session" }]);
});

test("adapter findByUid returns undefined when payload kind mismatches current model", async () => {
  const store = createMockStore(async () => ({
    kind: "AuthorizationCode",
    uid: "shared-uid",
    value: "payload"
  }));
  const Adapter = createAdapter(store);
  const sessionAdapter = new Adapter("Session");

  const result = await sessionAdapter.findByUid("shared-uid");

  assert.equal(result, undefined);
});

test("adapter findByUid returns payload when payload kind matches current model", async () => {
  const store = createMockStore(async () => ({
    kind: "Session",
    uid: "session-uid",
    value: "ok"
  }));
  const Adapter = createAdapter(store);
  const sessionAdapter = new Adapter("Session");

  const result = await sessionAdapter.findByUid("session-uid");

  assert.equal(result?.["value"], "ok");
});

test("adapter Client.find returns provider metadata for active client only", async () => {
  const store = createMockStore(
    async () => undefined,
    async (clientId) => {
      if (clientId !== "client-a") {
        return null;
      }
      const now = new Date().toISOString();
      return {
        clientId: "client-a",
        clientSecretDigest: "scrypt$test",
        applicationType: "web",
        tokenEndpointAuthMethod: "client_secret_basic",
        redirectUris: ["http://localhost:3002/demo/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/demo/logout-complete"],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        scopeWhitelist: ["openid", "profile"],
        requirePkce: true,
        autoConsent: false,
        status: "active",
        createdAt: now,
        updatedAt: now
      } satisfies OidcClientRecord;
    }
  );
  const Adapter = createAdapter(store);
  const clientAdapter = new Adapter("Client");
  const active = await clientAdapter.find("client-a");
  const missing = await clientAdapter.find("client-b");
  assert.equal(active?.["client_id"], "client-a");
  assert.equal(active?.["client_secret"], "placeholder:client-a");
  assert.equal(active?.["scope"], "openid profile");
  assert.equal(missing, undefined);
});
