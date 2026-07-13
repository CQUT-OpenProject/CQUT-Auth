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
  clientType: "web" as const,
  displayName: "Owner Portal",
  description: "OIDC portal",
  redirectUris: ["http://localhost:3002/callback"],
  postLogoutRedirectUris: ["http://localhost:3002/logout"],
  scopeWhitelist: ["openid", "profile"],
};
const owner = { subjectId: "subj_owner", isAdmin: false };
const admin = { subjectId: "subj_admin", isAdmin: true };

async function activeClient(
  service: ClientManagementService,
  input = webInput,
) {
  const created = await service.create(owner, input);
  const draft = created.client.proposedRevision!;
  const pending = await service.submit(owner, created.client.clientId, {
    revisionId: draft.revisionId,
    revisionVersion: draft.version,
  });
  return service.approve(admin, created.client.clientId, {
    revisionId: pending.proposedRevision!.revisionId,
    revisionVersion: pending.proposedRevision!.version,
  });
}

test("client creation produces a draft revision and never exposes secrets in audit", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(store, "test", {
      createClientId: () => "client_fixed",
      createSecret: () => "one-time-plaintext-secret",
    });
    const result = await service.create(owner, webInput);
    assert.equal(result.client.lifecycleStatus, "draft");
    assert.equal(result.client.proposedRevision?.status, "draft");
    assert.equal(result.clientSecret, "one-time-plaintext-secret");
    assert.equal("clientSecretDigest" in result.client, false);
    const stored = await store.findManagedOidcClient("client_fixed");
    assert.ok(stored?.client.clientSecretDigest);
    assert.equal(
      await verifyClientSecretDigest(
        result.clientSecret!,
        stored!.client.clientSecretDigest!,
      ),
      true,
    );
    const audit = await store.listOidcClientAuditLogs("client_fixed");
    assert.deepEqual(
      audit.map((entry) => entry.action),
      ["client.created", "revision.created", "client.secret_generated"],
    );
    assert.equal(
      audit.find((entry) => entry.action === "revision.created")
        ?.revisionNumber,
      1,
    );
    assert.equal(JSON.stringify(audit).includes(result.clientSecret!), false);
    assert.equal(JSON.stringify(audit).includes("scrypt$"), false);
  } finally {
    await store.close();
  }
});

test("client type is immutable and pending changes keep the active revision online", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(store, "test", {
      createClientId: () => "client_active",
    });
    const active = await activeClient(service);
    await assert.rejects(
      () =>
        service.update(owner, active.clientId, {
          clientVersion: active.clientVersion,
          clientType: "spa",
        }),
      /unsupported request field: clientType/,
    );
    const pending = await service.saveRevision(owner, active.clientId, {
      redirectUris: ["http://localhost:3002/new-callback"],
    });
    assert.equal(pending.proposedRevision?.status, "pending");
    assert.deepEqual(
      pending.activeRevision?.redirectUris,
      webInput.redirectUris,
    );
    assert.deepEqual(
      (await store.findOidcClient(active.clientId))?.redirectUris,
      webInput.redirectUris,
    );
  } finally {
    await store.close();
  }
});

test("withdraw, edit, resubmit and rejection preserve the active configuration", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(store, "test", {
      createClientId: () => "client_revision",
    });
    const active = await activeClient(service);
    const pending = await service.saveRevision(owner, active.clientId, {
      scopeWhitelist: ["openid", "email"],
    });
    const withdrawn = await service.withdraw(owner, active.clientId, {
      revisionId: pending.proposedRevision!.revisionId,
      revisionVersion: pending.proposedRevision!.version,
    });
    assert.equal(withdrawn.proposedRevision?.status, "draft");
    const edited = await service.saveRevision(owner, active.clientId, {
      revisionId: withdrawn.proposedRevision!.revisionId,
      revisionVersion: withdrawn.proposedRevision!.version,
      scopeWhitelist: ["openid", "profile", "email"],
    });
    const resubmitted = await service.submit(owner, active.clientId, {
      revisionId: edited.proposedRevision!.revisionId,
      revisionVersion: edited.proposedRevision!.version,
    });
    const rejected = await service.reject(admin, active.clientId, {
      revisionId: resubmitted.proposedRevision!.revisionId,
      revisionVersion: resubmitted.proposedRevision!.version,
      reason: "scope purpose is unclear",
    });
    assert.equal(
      rejected.proposedRevision?.rejectionReason,
      "scope purpose is unclear",
    );
    assert.deepEqual(
      rejected.activeRevision?.scopeWhitelist,
      webInput.scopeWhitelist,
    );
    const newDraft = await service.saveRevision(owner, active.clientId, {
      scopeWhitelist: ["openid", "email"],
    });
    assert.equal(newDraft.proposedRevision?.status, "draft");
    assert.notEqual(
      newDraft.proposedRevision?.revisionId,
      rejected.proposedRevision?.revisionId,
    );
    assert.deepEqual(
      (await store.findOidcClient(active.clientId))?.scopeWhitelist,
      webInput.scopeWhitelist,
    );
  } finally {
    await store.close();
  }
});

test("concurrent approval atomically activates one revision", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(store, "test", {
      createClientId: () => "client_concurrent",
    });
    const created = await service.create(owner, {
      ...webInput,
      clientType: "spa",
    });
    const draft = created.client.proposedRevision!;
    const pending = await service.submit(owner, created.client.clientId, {
      revisionId: draft.revisionId,
      revisionVersion: draft.version,
    });
    const input = {
      revisionId: pending.proposedRevision!.revisionId,
      revisionVersion: pending.proposedRevision!.version,
    };
    const results = await Promise.allSettled([
      service.approve(admin, created.client.clientId, input),
      service.approve(admin, created.client.clientId, input),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof ClientManagementError);
    assert.equal(rejected.reason.status, 409);
    assert.equal(
      (await store.findManagedOidcClient(created.client.clientId))?.client
        .lifecycleStatus,
      "active",
    );
  } finally {
    await store.close();
  }
});

test("configuration validation requires openid and forbids SPA offline_access", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(store, "test");
    await assert.rejects(
      () => service.create(owner, { ...webInput, scopeWhitelist: ["profile"] }),
      /must include openid/,
    );
    await assert.rejects(
      () =>
        service.create(owner, {
          ...webInput,
          clientType: "spa",
          scopeWhitelist: ["openid", "offline_access"],
        }),
      /SPA clients cannot request offline_access/,
    );
  } finally {
    await store.close();
  }
});

test("client and pending revision quotas cannot be bypassed", async () => {
  const store = new OidcPersistenceImpl(config());
  await store.init();
  try {
    let id = 0;
    const pendingLimited = new ClientManagementService(store, "test", {
      createClientId: () => `quota_${++id}`,
      maxClientsPerOwner: 3,
      maxPendingClientsPerOwner: 1,
      adminQuotaExempt: false,
    });
    const first = await pendingLimited.create(owner, {
      ...webInput,
      clientType: "spa",
    });
    const second = await pendingLimited.create(owner, {
      ...webInput,
      clientType: "spa",
    });
    await pendingLimited.submit(owner, first.client.clientId, {
      revisionId: first.client.proposedRevision!.revisionId,
      revisionVersion: first.client.proposedRevision!.version,
    });
    await assert.rejects(
      () =>
        pendingLimited.submit(owner, second.client.clientId, {
          revisionId: second.client.proposedRevision!.revisionId,
          revisionVersion: second.client.proposedRevision!.version,
        }),
      (error: unknown) =>
        error instanceof ClientManagementError && error.status === 409,
    );

    const totalLimited = new ClientManagementService(store, "test", {
      createClientId: () => `total_${++id}`,
      maxClientsPerOwner: 2,
      maxPendingClientsPerOwner: 2,
      adminQuotaExempt: false,
    });
    await assert.rejects(
      () => totalLimited.create(owner, { ...webInput, clientType: "spa" }),
      (error: unknown) =>
        error instanceof ClientManagementError &&
        error.code === "client_quota_exceeded",
    );
  } finally {
    await store.close();
  }
});
