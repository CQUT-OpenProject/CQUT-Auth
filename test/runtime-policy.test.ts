import assert from "node:assert/strict";
import test from "node:test";
import { readOidcOpConfig } from "../src/config.js";
import { encryptJson } from "../src/crypto.js";
import { emptyEmailSettings } from "../src/email/email-settings.js";
import { AppSettingsRepositoryImpl } from "../src/persistence/app-settings.repository.js";
import {
  defaultRuntimePolicy,
  RuntimePolicyService,
} from "../src/runtime-policy.js";

const secret = "test-runtime-policy-key";

function config() {
  return readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: secret,
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-runtime-artifact-key",
  });
}

test("runtime policy saves a pending version without changing the active snapshot", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const activeConfig = config();
  const defaults = defaultRuntimePolicy(activeConfig);
  const service = new RuntimePolicyService(store, secret, defaults);
  await service.initialize(activeConfig);

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
  assert.equal(activeConfig.accessTokenTtlSeconds, 300);

  const restartedConfig = config();
  const restarted = new RuntimePolicyService(
    store,
    secret,
    defaultRuntimePolicy(restartedConfig),
  );
  await restarted.initialize(restartedConfig);
  assert.equal(restartedConfig.accessTokenTtlSeconds, 901);
  assert.equal((await restarted.getView()).restartRequired, false);
});

test("runtime policy rejects cross-field violations atomically", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const activeConfig = config();
  const defaults = defaultRuntimePolicy(activeConfig);
  const service = new RuntimePolicyService(store, secret, defaults);
  await service.initialize(activeConfig);

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

test("runtime policy migrates the legacy encrypted email row", async () => {
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
      action: "email_settings.updated",
      changedFields: ["email"],
      previousValues: {},
      newValues: {},
      secretsReplaced: {},
      createdAt: now,
    },
  });
  const activeConfig = config();
  const service = new RuntimePolicyService(
    store,
    secret,
    defaultRuntimePolicy(activeConfig),
  );
  await service.initialize(activeConfig);
  const view = await service.getView();
  assert.equal(view.email.provider, "resend");
  assert.equal(view.email.resend.apiKeyConfigured, true);
  assert.equal(view.version, 1);
  assert.equal(view.restartRequired, false);
});
