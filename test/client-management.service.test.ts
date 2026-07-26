import assert from "node:assert/strict";
import test from "node:test";
import { ClientManagementService } from "../src/clients/client-management.service.js";
import { ClientManagementError } from "../src/management/management-error.js";
import { readConfig } from "../src/config.js";
import { verifyClientSecretDigest } from "../src/crypto.js";
import { createPersistence } from "../src/persistence/persistence.js";
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

async function activeClient(
  service: ClientManagementService,
  input = webInput,
) {
  const created = await service.create(owner, SYSTEM_PROJECT_ID, input);
  return created.client;
}

test("client creation activates immediately and never exposes secrets in audit", async () => {
  const modules = await createPersistence(config());
  const store = modules.clients;
  const projects = modules.projects;
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(projects),
      "test",
      {
        createClientId: () => "client_fixed",
        createSecret: () => "one-time-plaintext-secret",
      },
    );
    const result = await service.create(owner, SYSTEM_PROJECT_ID, webInput);
    assert.equal(result.client.lifecycleStatus, "active");
    assert.equal(result.client.activeRevision?.status, "approved");
    assert.equal(result.client.proposedRevision, null);
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
      [
        "client.created",
        "revision.created",
        "revision.activated",
        "client.secret_generated",
      ],
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
    await modules.runtime.close();
  }
});

test("secret rotation enforces grace, expiry, revocation, and optimistic concurrency", async () => {
  const modules = await createPersistence(config());
  const store = modules.clients;
  const projects = modules.projects;
  let secretNumber = 0;
  const service = new ClientManagementService(
    store,
    new ProjectAccessService(projects),
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

    const rotated = await service.rotateSecret(
      owner,
      SYSTEM_PROJECT_ID,
      created.client.clientId,
      {
        clientVersion: created.client.clientVersion,
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
    await modules.runtime.close();
  }
});

test("secret rotation preflight and cooldown run before scrypt digest work", async () => {
  const modules = await createPersistence(config());
  const store = modules.clients;
  const projects = modules.projects;
  let now = new Date("2026-07-13T00:00:00.000Z");
  let digestCalls = 0;
  const service = new ClientManagementService(
    store,
    new ProjectAccessService(projects),
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
    await modules.runtime.close();
  }
});

test("client type is immutable and revision changes activate immediately", async () => {
  const modules = await createPersistence(config());
  const store = modules.clients;
  const projects = modules.projects;
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(projects),
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
    const updated = await service.saveRevision(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        redirectUris: ["http://localhost:3002/new-callback"],
      },
    );
    assert.equal(updated.proposedRevision, null);
    assert.deepEqual(updated.activeRevision?.redirectUris, [
      "http://localhost:3002/new-callback",
    ]);
    assert.deepEqual(
      (await store.findOidcClient(active.clientId))?.redirectUris,
      ["http://localhost:3002/new-callback"],
    );
  } finally {
    await modules.runtime.close();
  }
});

test("revision save stacks approved active configurations", async () => {
  const modules = await createPersistence(config());
  const store = modules.clients;
  const projects = modules.projects;
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(projects),
      "test",
      {
        createClientId: () => "client_revision",
      },
    );
    const active = await activeClient(service);
    const first = await service.saveRevision(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        scopeWhitelist: ["openid", "email"],
      },
    );
    assert.equal(first.proposedRevision, null);
    assert.deepEqual(first.activeRevision?.scopeWhitelist, ["openid", "email"]);
    const second = await service.saveRevision(
      owner,
      SYSTEM_PROJECT_ID,
      active.clientId,
      {
        redirectUris: ["http://localhost:3002/revision-3"],
      },
    );
    assert.equal(second.activeRevision?.revisionNumber, 3);
    assert.deepEqual(second.activeRevision?.scopeWhitelist, [
      "openid",
      "email",
    ]);
    assert.deepEqual(
      (await store.findOidcClient(active.clientId))?.redirectUris,
      ["http://localhost:3002/revision-3"],
    );
  } finally {
    await modules.runtime.close();
  }
});

test("configuration validation requires openid and forbids SPA offline_access", async () => {
  const modules = await createPersistence(config());
  const store = modules.clients;
  const projects = modules.projects;
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(projects),
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
    await modules.runtime.close();
  }
});

test("client quotas cannot be bypassed", async () => {
  const modules = await createPersistence(config());
  const store = modules.clients;
  const projects = modules.projects;
  try {
    let id = 0;
    const totalLimited = new ClientManagementService(
      store,
      new ProjectAccessService(projects),
      "test",
      {
        createClientId: () => `total_${++id}`,
        maxClientsPerProject: 1,
        adminQuotaExempt: false,
      },
    );
    await totalLimited.create(owner, SYSTEM_PROJECT_ID, {
      ...webInput,
      clientType: "spa",
    });
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
    await modules.runtime.close();
  }
});

test("web clients can disable PKCE on creation and toggle it via update", async () => {
  const modules = await createPersistence(config());
  const store = modules.clients;
  const projects = modules.projects;
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(projects),
      "test",
    );
    const created = await service.create(owner, SYSTEM_PROJECT_ID, {
      ...webInput,
      requirePkce: false,
    });
    assert.equal(created.client.requirePkce, false);

    const updated = await service.update(
      owner,
      SYSTEM_PROJECT_ID,
      created.client.clientId,
      { clientVersion: created.client.clientVersion, requirePkce: true },
    );
    assert.equal(updated.requirePkce, true);
    assert.ok(
      (await store.listOidcClientAuditLogs(created.client.clientId)).some(
        (entry) =>
          entry.action === "client.updated" &&
          entry.changedFields.includes("requirePkce"),
      ),
    );
  } finally {
    await modules.runtime.close();
  }
});

test("SPA clients cannot disable PKCE on creation or update", async () => {
  const modules = await createPersistence(config());
  const store = modules.clients;
  const projects = modules.projects;
  try {
    const service = new ClientManagementService(
      store,
      new ProjectAccessService(projects),
      "test",
    );
    await assert.rejects(
      () =>
        service.create(owner, SYSTEM_PROJECT_ID, {
          ...webInput,
          clientType: "spa",
          requirePkce: false,
        }),
      (error: unknown) =>
        error instanceof ClientManagementError && error.field === "requirePkce",
    );

    const created = await service.create(owner, SYSTEM_PROJECT_ID, {
      ...webInput,
      clientType: "spa",
    });
    assert.equal(created.client.requirePkce, true);
    await assert.rejects(
      () =>
        service.update(owner, SYSTEM_PROJECT_ID, created.client.clientId, {
          clientVersion: created.client.clientVersion,
          requirePkce: false,
        }),
      (error: unknown) =>
        error instanceof ClientManagementError && error.field === "requirePkce",
    );
  } finally {
    await modules.runtime.close();
  }
});
