import { randomUUID } from "node:crypto";
import { decryptJson, encryptJson } from "../crypto.js";
import { ClientManagementError } from "../management/management-error.js";
import type {
  AppSettingAuditRecord,
  AppSettingsRepository,
} from "../persistence/contracts.js";
import { isValidEmail } from "../utils.js";
import type { EmailSender } from "./email-sender.js";
import {
  EMAIL_SETTINGS_KEY,
  emptyEmailSettings,
  type EmailProviderKind,
  type EmailSettings,
  type EmailSettingsSource,
  type EmailSettingsView,
} from "./email-settings.js";

const PROVIDER_KINDS: readonly EmailProviderKind[] = [
  "resend",
  "smtp",
  "disabled",
];

export type EmailSettingsEnvDefaults = {
  resendApiKey?: string | undefined;
  emailFrom?: string | undefined;
};

export type EmailSettingsActor = {
  subjectId: string;
  sourceIp?: string | undefined;
};

type EmailSettingsUpdateInput = Record<string, unknown>;

/**
 * Reads/writes the encrypted email settings row and exposes both a redacted
 * view (for the management API) and the effective settings (for the sender).
 * Secrets are kept out of the API surface entirely; blank secret fields on
 * update are treated as "keep the currently effective value".
 */
export class EmailSettingsService {
  constructor(
    private readonly store: Pick<
      AppSettingsRepository,
      "getAppSetting" | "saveAppSetting" | "listAppSettingAuditLogs"
    >,
    private readonly encryptionSecret: string,
    private readonly envDefaults: EmailSettingsEnvDefaults = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Effective settings the sender should honor (stored row wins over env). */
  async loadEffective(): Promise<EmailSettings> {
    const stored = await this.loadStored();
    if (stored) {
      return stored.settings;
    }
    return this.envDerivedSettings();
  }

  /** Redacted projection for the management panel. */
  async getView(): Promise<EmailSettingsView> {
    const stored = await this.loadStored();
    if (stored) {
      return toView(
        stored.settings,
        stored.updatedAt,
        stored.version,
        "database",
      );
    }
    const settings = this.envDerivedSettings();
    return toView(
      settings,
      null,
      0,
      settings.provider === "disabled" ? "default" : "environment",
    );
  }

  async update(raw: unknown, actor: EmailSettingsActor): Promise<EmailSettingsView> {
    const input = requireObject(raw);
    const stored = await this.loadStored();
    const current = stored?.settings ?? this.envDerivedSettings();
    const expectedVersion = parseExpectedVersion(input["expectedVersion"]);
    const currentVersion = stored?.version ?? 0;
    if (expectedVersion !== currentVersion) {
      versionConflict();
    }

    const merged = mergeSettings(current, input);
    validate(merged);
    const updatedAt = this.now().toISOString();
    const secretsReplaced = {
      resendApiKey: secretWasReplaced(
        optionalObject(input["resend"], "resend")["apiKey"],
      ),
      smtpPassword: secretWasReplaced(
        optionalObject(input["smtp"], "smtp")["password"],
      ),
    };
    const record = await this.save(
      merged,
      expectedVersion,
      updatedAt,
      {
        actorSubjectId: actor.subjectId,
        action: "email_settings.updated",
        changedFields: changedFields(current, merged, secretsReplaced),
        previousValues: auditValues(current),
        newValues: auditValues(merged),
        secretsReplaced,
        ...(actor.sourceIp ? { sourceIp: actor.sourceIp } : {}),
        createdAt: updatedAt,
      },
    );
    return toView(merged, record.updatedAt, record.version, "database");
  }

  async sendTest(
    raw: unknown,
    actor: EmailSettingsActor,
    sender: EmailSender,
  ): Promise<EmailSettingsView> {
    const input = requireObject(raw);
    const stored = await this.loadStored();
    const settings = stored?.settings ?? this.envDerivedSettings();
    const expectedVersion = parseExpectedVersion(input["expectedVersion"]);
    const currentVersion = stored?.version ?? 0;
    if (expectedVersion !== currentVersion) {
      versionConflict();
    }
    if (settings.provider === "disabled") {
      throw new ClientManagementError(
        400,
        "invalid_request",
        "email provider must be enabled before sending a test email",
        "provider",
      );
    }
    validate(settings);
    const recipient = requiredEmail(input["recipient"]);
    await sender.sendVerificationCode({
      to: recipient,
      code: "000000",
      interactionUid: `email-settings-test-${randomUUID()}`,
      expiresInSeconds: 600,
    });

    const verifiedAt = this.now().toISOString();
    const verified = { ...settings, lastVerifiedAt: verifiedAt };
    const record = await this.save(
      verified,
      expectedVersion,
      verifiedAt,
      {
        actorSubjectId: actor.subjectId,
        action: "email_settings.verified",
        changedFields: ["verification"],
        previousValues: auditValues(settings),
        newValues: auditValues(verified),
        secretsReplaced: {
          resendApiKey: false,
          smtpPassword: false,
        },
        ...(actor.sourceIp ? { sourceIp: actor.sourceIp } : {}),
        createdAt: verifiedAt,
      },
    );
    return toView(verified, record.updatedAt, record.version, "database");
  }

  async listAuditLogs(limit = 50) {
    return this.store.listAppSettingAuditLogs(EMAIL_SETTINGS_KEY, limit);
  }

  private async save(
    settings: EmailSettings,
    expectedVersion: number,
    updatedAt: string,
    audit: Omit<
      AppSettingAuditRecord,
      "id" | "settingKey" | "previousVersion" | "newVersion"
    >,
  ) {
    const result = await this.store.saveAppSetting({
      key: EMAIL_SETTINGS_KEY,
      valueCiphertext: await encryptJson(this.encryptionSecret, settings),
      expectedVersion,
      updatedAt,
      audit,
    });
    if (result.status === "version_conflict") {
      versionConflict();
    }
    return result.record;
  }

  private async loadStored(): Promise<{
    settings: EmailSettings;
    version: number;
    updatedAt: string;
  } | null> {
    const record = await this.store.getAppSetting(EMAIL_SETTINGS_KEY);
    if (!record) {
      return null;
    }
    const decrypted = await decryptJson<EmailSettings>(
      this.encryptionSecret,
      record.valueCiphertext,
    );
    return {
      settings: normalizeStored(decrypted),
      version: record.version,
      updatedAt: record.updatedAt,
    };
  }

  private envDerivedSettings(): EmailSettings {
    const apiKey = this.envDefaults.resendApiKey?.trim();
    const from = this.envDefaults.emailFrom?.trim();
    if (apiKey && from) {
      return { provider: "resend", resend: { apiKey, from }, smtp: {} };
    }
    return emptyEmailSettings();
  }
}

function normalizeStored(value: EmailSettings): EmailSettings {
  const base = emptyEmailSettings();
  return {
    provider: PROVIDER_KINDS.includes(value?.provider)
      ? value.provider
      : "disabled",
    resend: { ...base.resend, ...(value?.resend ?? {}) },
    smtp: { ...base.smtp, ...(value?.smtp ?? {}) },
    ...(typeof value?.lastVerifiedAt === "string"
      ? { lastVerifiedAt: value.lastVerifiedAt }
      : {}),
  };
}

function mergeSettings(
  current: EmailSettings,
  input: EmailSettingsUpdateInput,
): EmailSettings {
  const provider = input["provider"];
  if (!PROVIDER_KINDS.includes(provider as EmailProviderKind)) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      "provider must be one of resend, smtp, disabled",
      "provider",
    );
  }
  const resendInput = optionalObject(input["resend"], "resend");
  const smtpInput = optionalObject(input["smtp"], "smtp");
  const merged: EmailSettings = {
    provider: provider as EmailProviderKind,
    resend: {
      apiKey: keepSecret(
        resendInput["apiKey"],
        current.resend.apiKey,
        "resend.apiKey",
      ),
      from: optionalString(
        resendInput["from"],
        current.resend.from,
        "resend.from",
      ),
    },
    smtp: {
      host: optionalString(
        smtpInput["host"],
        current.smtp.host,
        "smtp.host",
      ),
      port: optionalPort(smtpInput["port"], current.smtp.port),
      secure: optionalBoolean(
        smtpInput["secure"],
        current.smtp.secure,
        "smtp.secure",
      ),
      user: optionalString(
        smtpInput["user"],
        current.smtp.user,
        "smtp.user",
      ),
      password: keepSecret(
        smtpInput["password"],
        current.smtp.password,
        "smtp.password",
      ),
      from: optionalString(
        smtpInput["from"],
        current.smtp.from,
        "smtp.from",
      ),
    },
  };
  return deliverySettingsEqual(current, merged) && current.lastVerifiedAt
    ? { ...merged, lastVerifiedAt: current.lastVerifiedAt }
    : merged;
}

function keepSecret(
  next: unknown,
  current: string | undefined,
  field: string,
): string | undefined {
  if (next === undefined || next === null) {
    return current;
  }
  if (typeof next !== "string") {
    throw new ClientManagementError(
      400,
      "invalid_request",
      `${field} must be a string`,
      field,
    );
  }
  const trimmed = next.trim();
  return trimmed.length > 0 ? trimmed : current;
}

function optionalString(
  next: unknown,
  current: string | undefined,
  field: string,
): string | undefined {
  if (next === undefined) {
    return current;
  }
  if (next === null) {
    return undefined;
  }
  if (typeof next !== "string") {
    throw new ClientManagementError(
      400,
      "invalid_request",
      `${field} must be a string`,
      field,
    );
  }
  const trimmed = next.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalPort(
  next: unknown,
  current: number | undefined,
): number | undefined {
  if (next === undefined) {
    return current;
  }
  if (next === null || next === "") {
    return undefined;
  }
  const port = Number(next);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      "smtp.port must be an integer between 1 and 65535",
      "smtp.port",
    );
  }
  return port;
}

function optionalBoolean(
  next: unknown,
  current: boolean | undefined,
  field: string,
): boolean | undefined {
  if (next === undefined) {
    return current;
  }
  if (typeof next !== "boolean") {
    throw new ClientManagementError(
      400,
      "invalid_request",
      `${field} must be a boolean`,
      field,
    );
  }
  return next;
}

function validate(settings: EmailSettings): void {
  if (settings.provider === "resend") {
    if (!settings.resend.apiKey) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        "Resend API key is required when the Resend provider is selected",
        "resend.apiKey",
      );
    }
    if (!settings.resend.from) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        "sender address is required when the Resend provider is selected",
        "resend.from",
      );
    }
  }
  if (settings.provider === "smtp") {
    if (!settings.smtp.host) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        "SMTP host is required when the SMTP provider is selected",
        "smtp.host",
      );
    }
    if (!settings.smtp.port) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        "SMTP port is required when the SMTP provider is selected",
        "smtp.port",
      );
    }
    if (!settings.smtp.from) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        "sender address is required when the SMTP provider is selected",
        "smtp.from",
      );
    }
  }
}

function toView(
  settings: EmailSettings,
  updatedAt: string | null,
  version: number,
  source: EmailSettingsSource,
): EmailSettingsView {
  return {
    provider: settings.provider,
    resend: {
      from: settings.resend.from ?? "",
      apiKeyConfigured: Boolean(settings.resend.apiKey),
    },
    smtp: {
      host: settings.smtp.host ?? "",
      port: settings.smtp.port ?? null,
      secure: settings.smtp.secure ?? false,
      user: settings.smtp.user ?? "",
      from: settings.smtp.from ?? "",
      passwordConfigured: Boolean(settings.smtp.password),
    },
    version,
    source,
    verification: {
      status:
        settings.provider === "disabled"
          ? "not_applicable"
          : settings.lastVerifiedAt
            ? "verified"
            : "unverified",
      verifiedAt: settings.lastVerifiedAt ?? null,
    },
    updatedAt,
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      "request body must be an object",
    );
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      `${field} must be an object`,
      field,
    );
  }
  return value as Record<string, unknown>;
}

function parseExpectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      "expectedVersion must be a non-negative integer",
      "expectedVersion",
    );
  }
  return Number(value);
}

function requiredEmail(value: unknown): string {
  const recipient = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!isValidEmail(recipient)) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      "recipient must be a valid email address",
      "recipient",
    );
  }
  return recipient;
}

function versionConflict(): never {
  throw new ClientManagementError(
    409,
    "version_conflict",
    "email settings changed concurrently; reload and retry",
  );
}

function secretWasReplaced(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function deliverySettingsEqual(left: EmailSettings, right: EmailSettings) {
  return (
    left.provider === right.provider &&
    left.resend.apiKey === right.resend.apiKey &&
    left.resend.from === right.resend.from &&
    left.smtp.host === right.smtp.host &&
    left.smtp.port === right.smtp.port &&
    left.smtp.secure === right.smtp.secure &&
    left.smtp.user === right.smtp.user &&
    left.smtp.password === right.smtp.password &&
    left.smtp.from === right.smtp.from
  );
}

function auditValues(settings: EmailSettings): Record<string, unknown> {
  return {
    provider: settings.provider,
    resendFrom: settings.resend.from ?? null,
    smtpHost: settings.smtp.host ?? null,
    smtpPort: settings.smtp.port ?? null,
    smtpSecure: settings.smtp.secure ?? false,
    smtpUser: settings.smtp.user ?? null,
    smtpFrom: settings.smtp.from ?? null,
  };
}

function changedFields(
  previous: EmailSettings,
  next: EmailSettings,
  secretsReplaced: Record<string, boolean>,
): string[] {
  const before = auditValues(previous);
  const after = auditValues(next);
  const fields = Object.keys(after).filter(
    (field) => before[field] !== after[field],
  );
  if (secretsReplaced["resendApiKey"]) fields.push("resend.apiKey");
  if (secretsReplaced["smtpPassword"]) fields.push("smtp.password");
  if (previous.lastVerifiedAt && !next.lastVerifiedAt) {
    fields.push("verification");
  }
  return fields;
}
