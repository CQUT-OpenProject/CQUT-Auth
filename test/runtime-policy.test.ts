import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { encryptJson } from "../src/crypto.js";
import { emptyEmailSettings } from "../src/email/email-settings.js";
import { AppSettingsRepositoryImpl } from "../src/persistence/app-settings.repository.js";
import {
  defaultRuntimePolicy,
  RuntimePolicyModule,
} from "../src/runtime-policy.js";

const secret = "test-runtime-policy-key";

function config() {
  return readConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: secret,
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-runtime-artifact-key",
  });
}

test("runtime policy saves a pending version without changing the active snapshot", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const activeConfig = config();
  const defaults = defaultRuntimePolicy(activeConfig);
  const service = new RuntimePolicyModule(store, secret, defaults);
  const active = await service.initialize();

  const nextPolicy = {
    ...defaults.policy,
    accessTokenTtlSeconds: 901,
  };
  const saved = await service.update(
    {
      expectedVersion: 0,
      policy: nextPolicy,
      email: emptyEmailSettings(),
    },
    { subjectId: "admin" },
  );

  assert.equal(saved.version, 1);
  assert.equal(saved.loadedVersion, 0);
  assert.equal(saved.restartRequired, true);
  assert.equal(active.policy.accessTokenTtlSeconds, 300);

  const restartedConfig = config();
  const restarted = new RuntimePolicyModule(
    store,
    secret,
    defaultRuntimePolicy(restartedConfig),
  );
  const restartedSnapshot = await restarted.initialize();
  assert.equal(restartedSnapshot.policy.accessTokenTtlSeconds, 901);
  assert.equal((await restarted.getView()).restartRequired, false);
});

test("runtime policy rejects cross-field violations atomically", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const activeConfig = config();
  const defaults = defaultRuntimePolicy(activeConfig);
  const service = new RuntimePolicyModule(store, secret, defaults);
  await service.initialize();

  await assert.rejects(
    service.update(
      {
        expectedVersion: 0,
        policy: {
          ...defaults.policy,
          sessionIdleTtlSeconds: defaults.policy.sessionTtlSeconds + 1,
        },
        email: emptyEmailSettings(),
      },
      { subjectId: "admin" },
    ),
    /session idle TTL must not exceed session TTL/,
  );
  assert.equal((await service.getView()).version, 0);
});

test("runtime policy ignores the removed legacy email row", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const now = new Date().toISOString();
  await store.saveAppSetting({
    key: "email",
    valueCiphertext: await encryptJson(secret, {
      provider: "resend",
      resend: { apiKey: "re_legacy", from: "legacy@example.com" },
      smtp: {},
      lastVerifiedAt: now,
    }),
    expectedVersion: 0,
    updatedAt: now,
    audit: {
      actorSubjectId: "admin",
      action: "runtime_policy.updated",
      changedFields: ["email"],
      previousValues: {},
      newValues: {},
      secretsReplaced: {},
      createdAt: now,
    },
  });
  const activeConfig = config();
  const service = new RuntimePolicyModule(
    store,
    secret,
    defaultRuntimePolicy(activeConfig),
  );
  await service.initialize();
  const view = await service.getView();
  assert.equal(view.email.provider, "disabled");
  assert.equal(view.email.resend.apiKeyConfigured, false);
  assert.equal(view.version, 0);
  assert.equal(view.restartRequired, false);
});
