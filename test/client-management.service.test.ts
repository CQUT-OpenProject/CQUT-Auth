import assert from "node:assert/strict";
import test from "node:test";
import {
  ClientManagementError,
  ClientManagementService,
} from "../src/clients/client-management.service.js";
import { readOidcOpConfig } from "../src/config.js";
import { verifyClientSecretDigest } from "../src/crypto.js";
import { OidcPersistenceImpl } from "../src/persistence/persistence.js";

function config() {
  return readOidcOpConfig({
    APP_ENV: "test",
    AUTH_PROVIDER: "mock",
    OIDC_KEY_ENCRYPTION_SECRET: "test-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-artifact-secret",
  });
}

const webInput = {
  clientType: "web",
  displayName: "Owner Portal",
  description: "OIDC portal",
  redirectUris: ["http://localhost:3002/callback"],
  postLogoutRedirectUris: ["http://localhost:3002/logout"],
  scopeWhitelist: ["openid", "profile"],
};

test("client management generates a one-time Web secret and safe audit records", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(store, "test", {
      createClientId: () => "client_fixed",
      createSecret: () => "one-time-plaintext-secret",
    });
    const result = await service.create(
      { subjectId: "subj_owner", isAdmin: false },
      webInput,
    );
    assert.equal(result.client.clientId, "client_fixed");
    assert.equal(result.client.status, "pending");
    assert.equal(result.clientSecret, "one-time-plaintext-secret");
    assert.equal("clientSecretDigest" in result.client, false);

    const stored = await store.findOidcClient("client_fixed");
    assert.ok(stored?.clientSecretDigest);
    assert.equal(
      await verifyClientSecretDigest(
        result.clientSecret!,
        stored.clientSecretDigest,
      ),
      true,
    );
    const audit = await store.listOidcClientAuditLogs("client_fixed");
    assert.deepEqual(
      audit.map((entry) => entry.action),
      ["client.created", "client.secret_generated"],
    );
    assert.equal(JSON.stringify(audit).includes(result.clientSecret!), false);
    assert.equal(JSON.stringify(audit).includes("scrypt$"), false);
  } finally {
    await store.close();
  }
});

test("client type is immutable and active sensitive configuration stays available", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    let nextId = 0;
    const service = new ClientManagementService(store, "test", {
      createClientId: () => `client_${++nextId}`,
    });
    const owner = { subjectId: "subj_owner", isAdmin: false };
    const admin = { subjectId: "subj_admin", isAdmin: true };
    const created = await service.create(owner, {
      ...webInput,
      clientType: "spa",
      scopeWhitelist: ["openid", "profile"],
    });
    assert.equal("clientSecret" in created, false);
    assert.equal(
      (await store.findOidcClient(created.client.clientId))
        ?.tokenEndpointAuthMethod,
      "none",
    );

    const active = await service.approve(admin, created.client.clientId, {
      version: 1,
    });
    assert.equal(active.status, "active");
    await assert.rejects(
      () =>
        service.update(owner, created.client.clientId, {
          version: active.version,
          clientType: "web",
        }),
      /unsupported request field: clientType/,
    );
    await assert.rejects(
      () =>
        service.update(owner, created.client.clientId, {
          version: active.version,
          redirectUris: ["http://localhost:3002/new-callback"],
        }),
      (error: unknown) =>
        error instanceof ClientManagementError && error.status === 409,
    );
    const unchanged = await store.findOidcClient(created.client.clientId);
    assert.equal(unchanged?.status, "active");
    assert.deepEqual(unchanged?.redirectUris, created.client.redirectUris);

    await assert.rejects(
      () =>
        service.get(
          { subjectId: "subj_other", isAdmin: false },
          created.client.clientId,
        ),
      (error: unknown) =>
        error instanceof ClientManagementError && error.status === 404,
    );
  } finally {
    await store.close();
  }
});

test("rejected clients expose the reason and require draft submission", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(store, "test", {
      createClientId: () => "client_rejected",
    });
    const owner = { subjectId: "subj_owner", isAdmin: false };
    const admin = { subjectId: "subj_admin", isAdmin: true };
    const created = await service.create(owner, {
      ...webInput,
      clientType: "spa",
    });
    const rejected = await service.reject(admin, created.client.clientId, {
      version: 1,
      reason: "callback ownership is unclear",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectionReason, "callback ownership is unclear");

    const draft = await service.update(owner, rejected.clientId, {
      version: rejected.version,
      description: "Added callback ownership details",
    });
    assert.equal(draft.status, "draft");
    assert.equal(draft.rejectionReason, "callback ownership is unclear");
    const submitted = await service.submit(owner, draft.clientId, {
      version: draft.version,
    });
    assert.equal(submitted.status, "pending");
    assert.equal(
      (await store.listOidcClientAuditLogs(draft.clientId)).at(-1)?.action,
      "client.submitted",
    );
  } finally {
    await store.close();
  }
});

test("client creation enforces owner quotas before generating more records", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    let nextId = 0;
    const service = new ClientManagementService(store, "test", {
      createClientId: () => `quota_${++nextId}`,
      maxClientsPerOwner: 1,
      maxPendingClientsPerOwner: 1,
      adminQuotaExempt: false,
    });
    const actor = { subjectId: "subj_owner", isAdmin: false };
    await service.create(actor, { ...webInput, clientType: "spa" });
    await assert.rejects(
      () => service.create(actor, { ...webInput, clientType: "spa" }),
      (error: unknown) =>
        error instanceof ClientManagementError &&
        error.code === "client_quota_exceeded",
    );
    assert.equal(
      (await store.listOidcClientsByOwner(actor.subjectId)).length,
      1,
    );
  } finally {
    await store.close();
  }
});

test("client management rejects submitted digest fields and wildcard redirects", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(store, "test");
    await assert.rejects(
      () =>
        service.create(
          { subjectId: "subj_owner", isAdmin: false },
          { ...webInput, clientSecretDigest: "scrypt$forged" },
        ),
      /unsupported request field/,
    );
    await assert.rejects(
      () =>
        service.create(
          { subjectId: "subj_owner", isAdmin: false },
          { ...webInput, redirectUris: ["https://*.example.com/callback"] },
        ),
      /must not contain wildcards/,
    );
  } finally {
    await store.close();
  }
});
