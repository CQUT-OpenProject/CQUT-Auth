import assert from "node:assert/strict";
import test from "node:test";
import { ClientManagementService } from "../src/clients/client-management.service.js";
import { ClientManagementError } from "../src/management/management-error.js";
import { readConfig } from "../src/config.js";
import { verifyClientSecretDigest } from "../src/crypto.js";
import { PersistenceRuntimeImpl } from "../src/persistence/persistence.js";
import { ProjectAccessService } from "../src/projects/project-access.js";
import { SYSTEM_PROJECT_ID } from "../src/persistence/contracts.js";

function config() {
  return readConfig({
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
const owner = { subjectId: "subj_owner", isAdmin: true };
const admin = { subjectId: "subj_admin", isAdmin: true };

async function activeClient(
  service: ClientManagementService,
  input = webInput,
) {
  const created = await service.create(owner, SYSTEM_PROJECT_ID, input);
  const draft = created.client.proposedRevision!;
  const pending = await service.submit(
    owner,
    SYSTEM_PROJECT_ID,
    created.client.clientId,
    {
      revisionId: draft.revisionId,
      revisionVersion: draft.version,
    },
  );
  return service.approve(admin, SYSTEM_PROJECT_ID, created.client.clientId, {
    revisionId: pending.proposedRevision!.revisionId,
    revisionVersion: pending.proposedRevision!.version,
  });
}

test("client creation produces a draft revision and never exposes secrets in audit", async () => {
  const store = new PersistenceRuntimeImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(store),
      "test",
      {
        createClientId: () => "client_fixed",
        createSecret: () => "one-time-plaintext-secret",
      },
    );
    const result = await service.create(owner, SYSTEM_PROJECT_ID, webInput);
    assert.equal(result.client.lifecycleStatus, "draft");
    assert.equal(result.client.proposedRevision?.status, "draft");
    assert.equal(result.clientSecret, "one-time-plaintext-secret");
    assert.equal("clientSecretDigest" in result.client, false);
    const stored = await store.findManagedOidcClient("client_fixed");
    assert.ok(stored?.secrets[0]?.secretDigest);
    assert.equal(
      await verifyClientSecretDigest(
        result.clientSecret!,
        stored!.secrets[0]!.secretDigest,
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
    assert.equal(
      audit.find((entry) => entry.action === "client.secret_generated")
        ?.secretId,
      result.client.secrets[0]?.secretId,
    );
    assert.equal(JSON.stringify(audit).includes(result.clientSecret!), false);
    assert.equal(JSON.stringify(audit).includes("scrypt$"), false);
  } finally {
    await store.close();
  }
});

test("secret rotation enforces grace, expiry, revocation, and optimistic concurrency", async () => {
  const store = new PersistenceRuntimeImpl(config());
  await store.init();
  let secretNumber = 0;
  const service = new ClientManagementService(
    store,
    new ProjectAccessService(store),
    "test",
    {
      createClientId: () => "client_secret_lifecycle",
      createSecretId: () => `secret_${secretNumber + 1}`,
      createSecret: () => `plaintext_secret_${++secretNumber}`,
    },
  );
  try {
    const created = await service.create(owner, SYSTEM_PROJECT_ID, webInput);
    const originalValue = created.clientSecret!;
    assert.equal(created.client.secrets.length, 1);
    assert.equal("secretDigest" in created.client.secrets[0]!, false);
    const submitted = await service.submit(
      owner,
      SYSTEM_PROJECT_ID,
      created.client.clientId,
      {
        revisionId: created.client.proposedRevision!.revisionId,
        revisionVersion: created.client.proposedRevision!.version,
      },
    );
    const approved = await service.approve(
      admin,
      SYSTEM_PROJECT_ID,
      created.client.clientId,
      {
        revisionId: submitted.proposedRevision!.revisionId,
        revisionVersion: submitted.proposedRevision!.version,
      },
    );

    const rotated = await service.rotateSecret(
      owner,
      SYSTEM_PROJECT_ID,
      created.client.clientId,
      {
        clientVersion: approved.clientVersion,
        gracePeriodSeconds: 1,
      },
    );
    assert.equal(rotated.secret.value, "plaintext_secret_2");
    assert.deepEqual(
      rotated.client.secrets.map((secret) => secret.status).sort(),
      ["active", "retiring"],
    );
    const usableDuringGrace = await store.findOidcClient(
      created.client.clientId,
    );
    assert.equal(usableDuringGrace?.clientSecretDigests.length, 2);
    assert.ok(
      await Promise.any(
        usableDuringGrace!.clientSecretDigests.map(async (digest) => {
          if (await verifyClientSecretDigest(originalValue, digest))
            return true;
          throw new Error("not matched");
        }),
      ),
    );

    await assert.rejects(
      () =>
        service.rotateSecret(
          owner,
          SYSTEM_PROJECT_ID,
          created.client.clientId,
          {
            clientVersion: rotated.client.clientVersion,
            gracePeriodSeconds: 60,
          },
        ),
      (error: unknown) =>
        error instanceof ClientManagementError &&
        error.code === "secret_limit_exceeded",
    );

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const afterExpiry = await store.findOidcClient(created.client.clientId);
    assert.equal(afterExpiry?.clientSecretDigests.length, 1);
    assert.equal(
      await verifyClientSecretDigest(
        originalValue,
        afterExpiry!.clientSecretDigests[0]!,
      ),
      false,
    );

    const concurrentVersion = rotated.client.clientVersion;
    const attempts = await Promise.allSettled([
      service.rotateSecret(owner, SYSTEM_PROJECT_ID, created.client.clientId, {
        clientVersion: concurrentVersion,
        gracePeriodSeconds: 0,
      }),
      service.rotateSecret(owner, SYSTEM_PROJECT_ID, created.client.clientId, {
        clientVersion: concurrentVersion,
        gracePeriodSeconds: 0,
      }),
    ]);
    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      1,
    );
    const current = await service.get(
      owner,
      SYSTEM_PROJECT_ID,
      created.client.clientId,
    );
    const active = current.secrets.find(
      (secret) => secret.status === "active",
    )!;
    const revoked = await service.revokeSecret(
      owner,
      SYSTEM_PROJECT_ID,
      created.client.clientId,
      active.secretId,
      {
        clientVersion: current.clientVersion,
        secretVersion: active.version,
      },
    );
    assert.equal(
      revoked.secrets.find((secret) => secret.secretId === active.secretId)
        ?.status,
      "revoked",
    );
    assert.equal(
      (await store.findOidcClient(created.client.clientId))?.clientSecretDigests
        .length,
      0,
    );
    const audits = await store.listOidcClientAuditLogs(created.client.clientId);
    assert.ok(
      audits.some(
        (entry) =>
          entry.action === "client.secret_retired" &&
          entry.secretId === created.client.secrets[0]?.secretId,
      ),
    );
    assert.equal(JSON.stringify(audits).includes("plaintext_secret"), false);
    assert.equal(JSON.stringify(audits).includes("scrypt$"), false);
  } finally {
    await store.close();
  }
});

test("secret rotation preflight and cooldown run before scrypt digest work", async () => {
  const store = new PersistenceRuntimeImpl(config());
  await store.init();
  let now = new Date("2026-07-13T00:00:00.000Z");
  let digestCalls = 0;
  const service = new ClientManagementService(
    store,
    new ProjectAccessService(store),
    "test",
    {
      now: () => now,
      createClientId: () => "client_rotation_amplification",
      createSecret: () => `secret-value-${digestCalls + 1}`,
      createSecretId: () => `secret-id-${digestCalls + 1}`,
      digestSecret: async () => {
        digestCalls += 1;
        return `scrypt$test-${digestCalls}`;
      },
      minimumSecretRotationIntervalSeconds: 60,
    },
  );
  try {
    const created = await service.create(owner, SYSTEM_PROJECT_ID, webInput);
    assert.equal(digestCalls, 1);
    await assert.rejects(
      () =>
        service.rotateSecret(
          owner,
          SYSTEM_PROJECT_ID,
          created.client.clientId,
          {
            clientVersion: created.client.clientVersion,
            gracePeriodSeconds: 0,
          },
        ),
      (error: unknown) =>
        error instanceof ClientManagementError && error.code === "rate_limited",
    );
    assert.equal(digestCalls, 1);

    now = new Date("2026-07-13T00:01:01.000Z");
    const rotated = await service.rotateSecret(
      owner,
      SYSTEM_PROJECT_ID,
      created.client.clientId,
      {
        clientVersion: created.client.clientVersion,
        gracePeriodSeconds: 0,
      },
    );
    assert.equal(digestCalls, 2);
    await assert.rejects(
      () =>
        service.rotateSecret(
          owner,
          SYSTEM_PROJECT_ID,
          created.client.clientId,
          {
            clientVersion: created.client.clientVersion,
            gracePeriodSeconds: 0,
          },
        ),
      (error: unknown) =>
        error instanceof ClientManagementError &&
        error.code === "version_conflict",
    );
    assert.equal(digestCalls, 2);
    assert.equal(rotated.client.secrets[0]?.status, "active");
  } finally {
    await store.close();
  }
});

test("client type is immutable and pending changes keep the active revision online", async () => {
  const store = new PersistenceRuntimeImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(store),
      "test",
      {
        createClientId: () => "client_active",
      },
    );
    const active = await activeClient(service);
    await assert.rejects(
      () =>
        service.update(owner, SYSTEM_PROJECT_ID, active.clientId, {
          clientVersion: active.clientVersion,
          clientType: "spa",
        }),
      /unsupported request field: clientType/,
    );
    const pending = await service.saveRevision(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        redirectUris: ["http://localhost:3002/new-callback"],
      },
    );
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
  const store = new PersistenceRuntimeImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(store),
      "test",
      {
        createClientId: () => "client_revision",
      },
    );
    const active = await activeClient(service);
    const pending = await service.saveRevision(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        scopeWhitelist: ["openid", "email"],
      },
    );
    const withdrawn = await service.withdraw(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        revisionId: pending.proposedRevision!.revisionId,
        revisionVersion: pending.proposedRevision!.version,
      },
    );
    assert.equal(withdrawn.proposedRevision?.status, "draft");
    const edited = await service.saveRevision(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        revisionId: withdrawn.proposedRevision!.revisionId,
        revisionVersion: withdrawn.proposedRevision!.version,
        scopeWhitelist: ["openid", "profile", "email"],
      },
    );
    const resubmitted = await service.submit(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        revisionId: edited.proposedRevision!.revisionId,
        revisionVersion: edited.proposedRevision!.version,
      },
    );
    const rejected = await service.reject(
      admin,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        revisionId: resubmitted.proposedRevision!.revisionId,
        revisionVersion: resubmitted.proposedRevision!.version,
        reason: "scope purpose is unclear",
      },
    );
    assert.equal(
      rejected.proposedRevision?.rejectionReason,
      "scope purpose is unclear",
    );
    assert.deepEqual(
      rejected.activeRevision?.scopeWhitelist,
      webInput.scopeWhitelist,
    );
    const newDraft = await service.saveRevision(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        scopeWhitelist: ["openid", "email"],
      },
    );
    assert.equal(newDraft.proposedRevision?.status, "draft");
    assert.notEqual(
      newDraft.proposedRevision?.revisionId,
      rejected.proposedRevision?.revisionId,
    );
    assert.deepEqual(
      (await store.findOidcClient(active.clientId))?.scopeWhitelist,
      webInput.scopeWhitelist,
    );
    const secondPending = await service.submit(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        revisionId: newDraft.proposedRevision!.revisionId,
        revisionVersion: newDraft.proposedRevision!.version,
      },
    );
    const secondApproved = await service.approve(
      admin,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        revisionId: secondPending.proposedRevision!.revisionId,
        revisionVersion: secondPending.proposedRevision!.version,
      },
    );
    assert.equal(secondApproved.proposedRevision, null);
    const nextPending = await service.saveRevision(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        redirectUris: ["http://localhost:3002/revision-4"],
      },
    );
    assert.equal(nextPending.proposedRevision?.revisionNumber, 4);
    assert.deepEqual(nextPending.proposedRevision?.scopeWhitelist, [
      "openid",
      "email",
    ]);
  } finally {
    await store.close();
  }
});

test("concurrent approval atomically activates one revision", async () => {
  const store = new PersistenceRuntimeImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(store),
      "test",
      {
        createClientId: () => "client_concurrent",
      },
    );
    const created = await service.create(owner, SYSTEM_PROJECT_ID, {
      ...webInput,
      clientType: "spa",
    });
    const draft = created.client.proposedRevision!;
    const pending = await service.submit(
      owner,
      SYSTEM_PROJECT_ID,
      created.client.clientId,
      {
        revisionId: draft.revisionId,
        revisionVersion: draft.version,
      },
    );
    const input = {
      revisionId: pending.proposedRevision!.revisionId,
      revisionVersion: pending.proposedRevision!.version,
    };
    const results = await Promise.allSettled([
      service.approve(admin, SYSTEM_PROJECT_ID, created.client.clientId, input),
      service.approve(admin, SYSTEM_PROJECT_ID, created.client.clientId, input),
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
  const store = new PersistenceRuntimeImpl(config());
  await store.init();
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(store),
      "test",
    );
    await assert.rejects(
      () =>
        service.create(owner, SYSTEM_PROJECT_ID, {
          ...webInput,
          scopeWhitelist: ["profile"],
        }),
      /must include openid/,
    );
    await assert.rejects(
      () =>
        service.create(owner, SYSTEM_PROJECT_ID, {
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
  const store = new PersistenceRuntimeImpl(config());
  await store.init();
  try {
    let id = 0;
    const pendingLimited = new ClientManagementService(
      store,
      new ProjectAccessService(store),
      "test",
      {
        createClientId: () => `quota_${++id}`,
        maxClientsPerProject: 3,
        maxPendingClientsPerProject: 1,
        adminQuotaExempt: false,
      },
    );
    const first = await pendingLimited.create(owner, SYSTEM_PROJECT_ID, {
      ...webInput,
      clientType: "spa",
    });
    const second = await pendingLimited.create(owner, SYSTEM_PROJECT_ID, {
      ...webInput,
      clientType: "spa",
    });
    await pendingLimited.submit(
      owner,
      SYSTEM_PROJECT_ID,
      first.client.clientId,
      {
        revisionId: first.client.proposedRevision!.revisionId,
        revisionVersion: first.client.proposedRevision!.version,
      },
    );
    await assert.rejects(
      () =>
        pendingLimited.submit(
          owner,
          SYSTEM_PROJECT_ID,
          second.client.clientId,
          {
            revisionId: second.client.proposedRevision!.revisionId,
            revisionVersion: second.client.proposedRevision!.version,
          },
        ),
      (error: unknown) =>
        error instanceof ClientManagementError &&
        error.status === 409 &&
        error.code === "pending_revision_quota_exceeded",
    );

    const firstPending = await pendingLimited.get(
      owner,
      SYSTEM_PROJECT_ID,
      first.client.clientId,
    );
    await pendingLimited.disable(
      owner,
      SYSTEM_PROJECT_ID,
      first.client.clientId,
      {
        clientVersion: firstPending.clientVersion,
      },
    );
    const released = await pendingLimited.submit(
      owner,
      SYSTEM_PROJECT_ID,
      second.client.clientId,
      {
        revisionId: second.client.proposedRevision!.revisionId,
        revisionVersion: second.client.proposedRevision!.version,
      },
    );
    assert.equal(released.proposedRevision?.status, "pending");
    assert.equal(
      (
        await pendingLimited.get(
          owner,
          SYSTEM_PROJECT_ID,
          first.client.clientId,
        )
      ).proposedRevision,
      null,
    );
    assert.ok(
      (await store.listOidcClientAuditLogs(first.client.clientId)).some(
        (entry) => entry.action === "revision.cancelled",
      ),
    );

    const totalLimited = new ClientManagementService(
      store,
      new ProjectAccessService(store),
      "test",
      {
        createClientId: () => `total_${++id}`,
        maxClientsPerProject: 1,
        maxPendingClientsPerProject: 2,
        adminQuotaExempt: false,
      },
    );
    await assert.rejects(
      () =>
        totalLimited.create(owner, SYSTEM_PROJECT_ID, {
          ...webInput,
          clientType: "spa",
        }),
      (error: unknown) =>
        error instanceof ClientManagementError &&
        error.code === "client_quota_exceeded",
    );
  } finally {
    await store.close();
  }
});
