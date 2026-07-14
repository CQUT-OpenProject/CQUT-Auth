import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettingRecord } from "../persistence/contracts.js";
import { EmailSettingsService } from "./email-settings.service.js";

const SECRET = "test-email-settings-encryption-secret";

class FakeSettingsStore {
  private record: AppSettingRecord | undefined;

  async getAppSetting(key: string): Promise<AppSettingRecord | null> {
    return this.record && this.record.key === key ? this.record : null;
  }

  async upsertAppSetting(input: {
    key: string;
    valueCiphertext: string;
    updatedAt: string;
  }): Promise<AppSettingRecord> {
    this.record = {
      key: input.key,
      valueCiphertext: input.valueCiphertext,
      version: (this.record?.version ?? 0) + 1,
      createdAt: this.record?.createdAt ?? input.updatedAt,
      updatedAt: input.updatedAt,
    };
    return this.record;
  }

  storedCiphertext(): string | undefined {
    return this.record?.valueCiphertext;
  }
}

test("email settings default to disabled when nothing is stored or configured", async () => {
  const service = new EmailSettingsService(new FakeSettingsStore(), SECRET);
  const view = await service.getView();
  assert.equal(view.provider, "disabled");
  assert.equal(view.resend.apiKeyConfigured, false);
  assert.equal(view.updatedAt, null);
  const effective = await service.loadEffective();
  assert.equal(effective.provider, "disabled");
});

test("email settings fall back to env-configured Resend without echoing the key", async () => {
  const service = new EmailSettingsService(new FakeSettingsStore(), SECRET, {
    resendApiKey: "re_env_secret_key",
    emailFrom: "noreply@example.edu.cn",
  });
  const view = await service.getView();
  assert.equal(view.provider, "resend");
  assert.equal(view.resend.from, "noreply@example.edu.cn");
  assert.equal(view.resend.apiKeyConfigured, true);
  // Redacted projection must never carry the plaintext secret.
  assert.equal(JSON.stringify(view).includes("re_env_secret_key"), false);
  const effective = await service.loadEffective();
  assert.equal(effective.resend.apiKey, "re_env_secret_key");
});

test("email settings persist an encrypted Resend key and redact it from the view", async () => {
  const store = new FakeSettingsStore();
  const service = new EmailSettingsService(store, SECRET);
  const view = await service.update({
    provider: "resend",
    resend: { apiKey: "re_live_1234567890", from: "noreply@example.edu.cn" },
  });
  assert.equal(view.provider, "resend");
  assert.equal(view.resend.apiKeyConfigured, true);
  assert.equal(JSON.stringify(view).includes("re_live_1234567890"), false);

  // The key must not be stored in plaintext at rest.
  const ciphertext = store.storedCiphertext();
  assert.ok(ciphertext);
  assert.equal(ciphertext.includes("re_live_1234567890"), false);

  const effective = await service.loadEffective();
  assert.equal(effective.resend.apiKey, "re_live_1234567890");
});

test("email settings keep the stored secret when the update leaves it blank", async () => {
  const store = new FakeSettingsStore();
  const service = new EmailSettingsService(store, SECRET);
  await service.update({
    provider: "resend",
    resend: { apiKey: "re_original_key", from: "a@example.edu.cn" },
  });
  await service.update({
    provider: "resend",
    resend: { apiKey: "", from: "changed@example.edu.cn" },
  });
  const effective = await service.loadEffective();
  assert.equal(effective.resend.apiKey, "re_original_key");
  assert.equal(effective.resend.from, "changed@example.edu.cn");
});

test("email settings reject selecting Resend without an effective key", async () => {
  const service = new EmailSettingsService(new FakeSettingsStore(), SECRET);
  await assert.rejects(
    () => service.update({ provider: "resend", resend: { from: "a@b.cn" } }),
    /Resend API key is required/,
  );
});

test("email settings validate required SMTP fields and switch provider", async () => {
  const store = new FakeSettingsStore();
  const service = new EmailSettingsService(store, SECRET);
  await assert.rejects(
    () => service.update({ provider: "smtp", smtp: { port: 465 } }),
    /SMTP host is required/,
  );
  const view = await service.update({
    provider: "smtp",
    smtp: {
      host: "smtp.example.edu.cn",
      port: 465,
      secure: true,
      user: "mailer",
      password: "smtp-secret",
      from: "noreply@example.edu.cn",
    },
  });
  assert.equal(view.provider, "smtp");
  assert.equal(view.smtp.host, "smtp.example.edu.cn");
  assert.equal(view.smtp.port, 465);
  assert.equal(view.smtp.passwordConfigured, true);
  assert.equal(JSON.stringify(view).includes("smtp-secret"), false);

  const effective = await service.loadEffective();
  assert.equal(effective.provider, "smtp");
  assert.equal(effective.smtp.password, "smtp-secret");
});

test("email settings reject invalid SMTP port values", async () => {
  const service = new EmailSettingsService(new FakeSettingsStore(), SECRET);
  await assert.rejects(
    () =>
      service.update({
        provider: "smtp",
        smtp: { host: "h", port: 70000, from: "a@b.cn" },
      }),
    /smtp.port must be an integer/,
  );
});
