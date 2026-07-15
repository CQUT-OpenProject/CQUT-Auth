import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppSettingAuditRecord,
  AppSettingRecord,
  AppSettingsRepository,
} from "../persistence/contracts.js";
import { EmailSettingsService } from "./email-settings.service.js";

const SECRET = "test-email-settings-encryption-secret";
const ACTOR = { subjectId: "subj_admin", sourceIp: "127.0.0.1" };

class FakeSettingsStore {
  private record: AppSettingRecord | undefined;
  private readonly audits: AppSettingAuditRecord[] = [];

  async getAppSetting(key: string): Promise<AppSettingRecord | null> {
    return this.record && this.record.key === key ? this.record : null;
  }

  async saveAppSetting(
    input: Parameters<AppSettingsRepository["saveAppSetting"]>[0],
  ): ReturnType<AppSettingsRepository["saveAppSetting"]> {
    if ((this.record?.version ?? 0) !== input.expectedVersion) {
      return { status: "version_conflict" };
    }
    this.record = {
      key: input.key,
      valueCiphertext: input.valueCiphertext,
      version: input.expectedVersion + 1,
      createdAt: this.record?.createdAt ?? input.updatedAt,
      updatedAt: input.updatedAt,
    };
    this.audits.push({
      id: this.audits.length + 1,
      settingKey: input.key,
      ...input.audit,
      previousVersion: input.expectedVersion,
      newVersion: this.record.version,
    });
    return { status: "updated", record: this.record };
  }

  async listAppSettingAuditLogs(
    key: string,
    limit: number,
  ): Promise<AppSettingAuditRecord[]> {
    return this.audits
      .filter((audit) => audit.settingKey === key)
      .slice(-limit)
      .reverse();
  }

  storedCiphertext(): string | undefined {
    return this.record?.valueCiphertext;
  }

  auditLogs(): AppSettingAuditRecord[] {
    return [...this.audits];
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

test("first update inherits the env-configured Resend key", async () => {
  const store = new FakeSettingsStore();
  const service = new EmailSettingsService(store, SECRET, {
    resendApiKey: "re_env_secret_key",
    emailFrom: "noreply@example.edu.cn",
  });

  const view = await service.update(
    {
      expectedVersion: 0,
      provider: "resend",
      resend: { apiKey: "", from: "changed@example.edu.cn" },
    },
    ACTOR,
  );

  assert.equal(view.resend.apiKeyConfigured, true);
  const effective = await service.loadEffective();
  assert.equal(effective.resend.apiKey, "re_env_secret_key");
  assert.equal(effective.resend.from, "changed@example.edu.cn");
});

test("email settings persist an encrypted Resend key and redact it from the view", async () => {
  const store = new FakeSettingsStore();
  const service = new EmailSettingsService(store, SECRET);
  const view = await service.update(
    {
      expectedVersion: 0,
      provider: "resend",
      resend: { apiKey: "re_live_1234567890", from: "noreply@example.edu.cn" },
    },
    ACTOR,
  );
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
  await service.update(
    {
      expectedVersion: 0,
      provider: "resend",
      resend: { apiKey: "re_original_key", from: "a@example.edu.cn" },
    },
    ACTOR,
  );
  await service.update(
    {
      expectedVersion: 1,
      provider: "resend",
      resend: { apiKey: "", from: "changed@example.edu.cn" },
    },
    ACTOR,
  );
  const effective = await service.loadEffective();
  assert.equal(effective.resend.apiKey, "re_original_key");
  assert.equal(effective.resend.from, "changed@example.edu.cn");
});

test("email settings reject selecting Resend without an effective key", async () => {
  const service = new EmailSettingsService(new FakeSettingsStore(), SECRET);
  await assert.rejects(
    () =>
      service.update(
        {
          expectedVersion: 0,
          provider: "resend",
          resend: { from: "a@b.cn" },
        },
        ACTOR,
      ),
    /Resend API key is required/,
  );
});

test("email settings validate required SMTP fields and switch provider", async () => {
  const store = new FakeSettingsStore();
  const service = new EmailSettingsService(store, SECRET);
  await assert.rejects(
    () =>
      service.update(
        { expectedVersion: 0, provider: "smtp", smtp: { port: 465 } },
        ACTOR,
      ),
    /SMTP host is required/,
  );
  const view = await service.update(
    {
      expectedVersion: 0,
      provider: "smtp",
      smtp: {
        host: "smtp.example.edu.cn",
        port: 465,
        secure: true,
        user: "mailer",
        password: "smtp-secret",
        from: "noreply@example.edu.cn",
      },
    },
    ACTOR,
  );
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
      service.update(
        {
          expectedVersion: 0,
          provider: "smtp",
          smtp: { host: "h", port: 70000, from: "a@b.cn" },
        },
        ACTOR,
      ),
    /smtp.port must be an integer/,
  );
});

test("email settings reject non-boolean SMTP secure values", async () => {
  const service = new EmailSettingsService(new FakeSettingsStore(), SECRET);
  await assert.rejects(
    () =>
      service.update(
        {
          expectedVersion: 0,
          provider: "smtp",
          smtp: {
            host: "smtp.example.edu.cn",
            port: 465,
            secure: "false",
            from: "a@b.cn",
          },
        },
        ACTOR,
      ),
    /smtp.secure must be a boolean/,
  );
});

test("email settings reject stale versions and audit updates without secrets", async () => {
  const store = new FakeSettingsStore();
  const service = new EmailSettingsService(store, SECRET);
  const saved = await service.update(
    {
      expectedVersion: 0,
      provider: "resend",
      resend: {
        apiKey: "re_audit_secret",
        from: "noreply@example.edu.cn",
      },
    },
    ACTOR,
  );
  assert.equal(saved.version, 1);

  await assert.rejects(
    () =>
      service.update(
        {
          expectedVersion: 0,
          provider: "disabled",
        },
        ACTOR,
      ),
    /changed concurrently/,
  );

  const audit = store.auditLogs()[0];
  assert.ok(audit);
  assert.equal(audit.actorSubjectId, ACTOR.subjectId);
  assert.equal(audit.sourceIp, ACTOR.sourceIp);
  assert.equal(audit.previousVersion, 0);
  assert.equal(audit.newVersion, 1);
  assert.equal(audit.secretsReplaced["resendApiKey"], true);
  assert.equal(JSON.stringify(audit).includes("re_audit_secret"), false);
});

test("test email records the last successful verification", async () => {
  const store = new FakeSettingsStore();
  const now = new Date("2026-07-14T12:00:00.000Z");
  const service = new EmailSettingsService(store, SECRET, {}, () => now);
  await service.update(
    {
      expectedVersion: 0,
      provider: "resend",
      resend: {
        apiKey: "re_test_secret",
        from: "noreply@example.edu.cn",
      },
    },
    ACTOR,
  );
  const sent: Array<{ to: string; code: string }> = [];
  const view = await service.sendTest(
    { expectedVersion: 1, recipient: "Admin@Example.edu.cn" },
    ACTOR,
    {
      async sendVerificationCode(input) {
        sent.push({ to: input.to, code: input.code });
      },
    },
  );

  assert.deepEqual(sent, [{ to: "admin@example.edu.cn", code: "000000" }]);
  assert.equal(view.version, 2);
  assert.equal(view.verification.status, "verified");
  assert.equal(view.verification.verifiedAt, now.toISOString());
  assert.equal(store.auditLogs()[1]?.action, "email_settings.verified");
});
