import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { encryptJson } from "../src/crypto.js";
import { emptyEmailSettings } from "../src/email/email-settings.js";
import type {
  EmailSender,
  SendVerificationCodeInput,
} from "../src/email/email-sender.js";
import { AppSettingsRepositoryImpl } from "../src/persistence/app-settings.repository.js";
import {
  defaultRuntimePolicy,
  RuntimePolicyModule,
} from "../src/runtime-policy.js";

const secret = "test-runtime-policy-key";

class FakeEmailSender implements EmailSender {
  readonly sent: SendVerificationCodeInput[] = [];
  async sendVerificationCode(input: SendVerificationCodeInput): Promise<void> {
    this.sent.push(input);
  }
}

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

test("runtime policy normalizes the sender and rejects malformed from addresses", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const defaults = defaultRuntimePolicy(config());
  const service = new RuntimePolicyModule(store, secret, defaults);
  await service.initialize();

  const saved = await service.update(
    {
      expectedVersion: 0,
      policy: defaults.policy,
      email: {
        provider: "resend",
        resend: { apiKey: "re_test", from: "Cialli Dev<noreply@example.com>" },
      },
    },
    { subjectId: "admin" },
  );
  assert.equal(saved.email.resend.from, "Cialli Dev <noreply@example.com>");

  await assert.rejects(
    service.update(
      {
        expectedVersion: saved.version,
        policy: defaults.policy,
        email: {
          provider: "resend",
          resend: { apiKey: "re_test", from: "CQUT-Auth" },
        },
      },
      { subjectId: "admin" },
    ),
    /sender must be 'email@example\.com' or 'Name <email@example\.com>'/,
  );
});

test("send test exercises the submitted draft without stamping the stored config", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const defaults = defaultRuntimePolicy(config());
  const service = new RuntimePolicyModule(store, secret, defaults);
  await service.initialize();
  await service.update(
    {
      expectedVersion: 0,
      policy: defaults.policy,
      email: {
        provider: "resend",
        resend: { apiKey: "re_saved", from: "Saved <saved@example.com>" },
      },
    },
    { subjectId: "admin" },
  );
  const sender = new FakeEmailSender();

  // A draft that differs from the stored settings is validated and sent, but
  // must not mark the stored configuration as verified nor bump its version.
  const draftView = await service.sendTest(
    {
      expectedVersion: 1,
      recipient: "Admin@Example.com",
      email: {
        provider: "resend",
        resend: { apiKey: "", from: "Draft <draft@example.com>" },
      },
    },
    { subjectId: "admin" },
    sender,
  );
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0]?.to, "admin@example.com");
  assert.equal(draftView.version, 1);
  assert.equal(draftView.email.verification.status, "unverified");

  // An invalid draft is rejected even though the stored settings are valid,
  // proving the draft is what actually gets tested.
  await assert.rejects(
    service.sendTest(
      {
        expectedVersion: 1,
        recipient: "admin@example.com",
        email: { provider: "smtp", smtp: {} },
      },
      { subjectId: "admin" },
      sender,
    ),
    /SMTP host, port and sender are required/,
  );

  // A draft identical to the stored settings keeps the legacy behaviour:
  // the stored configuration is stamped verified.
  const sameView = await service.sendTest(
    {
      expectedVersion: 1,
      recipient: "admin@example.com",
      email: {
        provider: "resend",
        resend: { apiKey: "", from: "Saved <saved@example.com>" },
      },
    },
    { subjectId: "admin" },
    sender,
  );
  assert.equal(sameView.version, 2);
  assert.equal(sameView.email.verification.status, "verified");
});

test("send test works against a draft before anything is saved", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const defaults = defaultRuntimePolicy(config());
  const service = new RuntimePolicyModule(store, secret, defaults);
  await service.initialize();
  const sender = new FakeEmailSender();

  const view = await service.sendTest(
    {
      expectedVersion: 0,
      recipient: "admin@example.com",
      email: {
        provider: "resend",
        resend: { apiKey: "re_draft", from: "Draft <draft@example.com>" },
      },
    },
    { subjectId: "admin" },
    sender,
  );
  assert.equal(sender.sent.length, 1);
  assert.equal(view.version, 0);
  assert.equal(view.email.provider, "disabled");
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

test("listAuditLogs returns app setting audit logs", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const defaults = defaultRuntimePolicy(config());
  const service = new RuntimePolicyModule(store, secret, defaults);
  await service.initialize();

  await service.update(
    {
      expectedVersion: 0,
      policy: defaults.policy,
      email: emptyEmailSettings(),
    },
    { subjectId: "admin-1" },
  );

  const logs = await service.listAuditLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.actorSubjectId, "admin-1");
  assert.equal(logs[0]?.action, "runtime_policy.updated");
});

test("runtime policy validates SMTP host safety and rejects metadata addresses or malformed hosts", async () => {
  const store = new AppSettingsRepositoryImpl(() => undefined);
  const defaults = defaultRuntimePolicy(config());
  const service = new RuntimePolicyModule(store, secret, defaults);
  await service.initialize();

  const dangerousHosts = [
    "169.254.169.254",
    "0.0.0.0",
    "255.255.255.255",
    "metadata.google.internal",
    "instance-data",
    "::",
    "[::]",
    "fd00:ec2::254",
    "[fd00:ec2::254]",
    "http://smtp.example.com",
    "smtp.example.com/path",
    "user@smtp.example.com",
  ];

  for (const host of dangerousHosts) {
    await assert.rejects(
      service.update(
        {
          expectedVersion: 0,
          policy: defaults.policy,
          email: {
            provider: "smtp",
            smtp: {
              host,
              port: 587,
              from: "noreply@example.com",
            },
          },
        },
        { subjectId: "admin" },
      ),
      /SMTP host is invalid or not permitted/,
      `Expected host "${host}" to be rejected`,
    );
  }

  // Valid SMTP host should succeed
  const saved = await service.update(
    {
      expectedVersion: 0,
      policy: defaults.policy,
      email: {
        provider: "smtp",
        smtp: {
          host: "smtp.cqut.edu.cn",
          port: 465,
          secure: true,
          from: "CQUT Auth <auth@cqut.edu.cn>",
        },
      },
    },
    { subjectId: "admin" },
  );
  assert.equal(saved.email.provider, "smtp");
  assert.equal(saved.email.smtp.host, "smtp.cqut.edu.cn");
});
