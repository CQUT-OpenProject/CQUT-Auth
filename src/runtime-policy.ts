import { randomUUID } from "node:crypto";
import type { OidcOpConfig } from "./config.js";
import { decryptJson, encryptJson } from "./crypto.js";
import type { EmailSender } from "./email/email-sender.js";
import { buildEmailSender } from "./email/runtime-email-sender.js";
import {
  emptyEmailSettings,
  type EmailSettings,
  type EmailSettingsView,
} from "./email/email-settings.js";
import { ClientManagementError } from "./management/management-error.js";
import type {
  AppSettingAuditRecord,
  AppSettingsRepository,
} from "./persistence/contracts.js";
import { isValidEmail } from "./utils.js";

export const RUNTIME_POLICY_KEY = "runtime-policy";
const LEGACY_EMAIL_SETTINGS_KEY = "email";

export const POLICY_KEYS = [
  "csrfTokenTtlSeconds",
  "sessionTtlSeconds",
  "sessionIdleTtlSeconds",
  "interactionTtlSeconds",
  "authorizationCodeTtlSeconds",
  "accessTokenTtlSeconds",
  "idTokenTtlSeconds",
  "refreshTokenTtlSeconds",
  "grantTtlSeconds",
  "emailVerifyCodeTtlSeconds",
  "emailVerifyResendCooldownSeconds",
  "emailVerifyMaxAttempts",
  "emailVerifyRateLimitSubjectMax",
  "emailVerifyRateLimitSubjectWindowSeconds",
  "emailVerifyRateLimitEmailMax",
  "emailVerifyRateLimitEmailWindowSeconds",
  "emailVerifyRateLimitDomainMax",
  "emailVerifyRateLimitDomainWindowSeconds",
  "emailVerifyRateLimitIpMax",
  "emailVerifyRateLimitIpWindowSeconds",
  "loginRateLimitMax",
  "loginRateLimitWindowSeconds",
  "loginFailureLimit",
  "loginFailureWindowSeconds",
  "tokenRateLimitMax",
  "tokenRateLimitWindowSeconds",
  "managementProjectMaxActivePerSubject",
  "managementProjectCreateRateLimitSubjectMax",
  "managementProjectCreateRateLimitIpMax",
  "managementProjectCreateRateLimitWindowSeconds",
  "managementProjectQuotaAdminExempt",
  "managementClientMaxPerProject",
  "managementClientMaxPendingPerProject",
  "managementClientMaxPerSubject",
  "managementClientMaxPendingPerSubject",
  "managementClientCreateRateLimitSubjectMax",
  "managementClientCreateRateLimitIpMax",
  "managementClientCreateRateLimitWindowSeconds",
  "managementClientQuotaAdminExempt",
  "clientSecretDefaultGraceSeconds",
  "clientSecretMaxGraceSeconds",
  "clientSecretRotateRateLimitSubjectMax",
  "clientSecretRotateRateLimitClientMax",
  "clientSecretRotateRateLimitIpMax",
  "clientSecretRotateRateLimitWindowSeconds",
  "clientSecretRotateMinimumIntervalSeconds",
] as const;

export type PolicyValues = Pick<OidcOpConfig, (typeof POLICY_KEYS)[number]>;
export type RuntimePolicy = { policy: PolicyValues; email: EmailSettings };

export type RuntimePolicyView = {
  policy: PolicyValues;
  email: EmailSettingsView;
  version: number;
  loadedVersion: number;
  restartRequired: boolean;
  updatedAt: string | null;
};

type Store = Pick<
  AppSettingsRepository,
  "getAppSetting" | "saveAppSetting" | "listAppSettingAuditLogs"
>;

export class RuntimePolicyService {
  private active!: RuntimePolicy;
  private loadedVersion = 0;

  constructor(
    private readonly store: Store,
    private readonly encryptionSecret: string,
    private readonly defaults: RuntimePolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(config: OidcOpConfig): Promise<void> {
    let stored = await this.loadStored();
    if (!stored) {
      try {
        stored = await this.migrateLegacyEmail();
      } catch (error) {
        if (!(error instanceof ClientManagementError) || error.status !== 409) {
          throw error;
        }
        stored = await this.loadStored();
      }
    }
    this.active = stored?.settings ?? structuredClone(this.defaults);
    validatePolicy(this.active.policy);
    validateEmail(this.active.email);
    this.loadedVersion = stored?.version ?? 0;
    Object.assign(config, this.active.policy);
  }

  async loadEffective(): Promise<EmailSettings> {
    return this.active.email;
  }

  isEmailConfigured(): boolean {
    return this.active.email.provider !== "disabled";
  }

  async getView(): Promise<RuntimePolicyView> {
    const stored = await this.loadStored();
    return this.toView(
      stored?.settings ?? this.defaults,
      stored?.version ?? 0,
      stored?.updatedAt ?? null,
    );
  }

  async update(raw: unknown, actor: Actor): Promise<RuntimePolicyView> {
    const input = object(raw, "request body");
    const stored = await this.loadStored();
    const current = stored?.settings ?? this.defaults;
    const expectedVersion = nonNegativeInteger(
      input["expectedVersion"],
      "expectedVersion",
    );
    if (expectedVersion !== (stored?.version ?? 0)) conflict();
    const policy = parsePolicy(input["policy"]);
    const email = mergeEmail(current.email, input["email"]);
    validatePolicy(policy);
    validateEmail(email);
    const next = { policy, email };
    const updatedAt = this.now().toISOString();
    const record = await this.save(next, expectedVersion, updatedAt, {
      actorSubjectId: actor.subjectId,
      action: "runtime_policy.updated",
      changedFields: changedFields(current, next),
      previousValues: auditValues(current),
      newValues: auditValues(next),
      secretsReplaced: secretChanges(input["email"]),
      ...(actor.sourceIp ? { sourceIp: actor.sourceIp } : {}),
      createdAt: updatedAt,
    });
    return this.toView(next, record.version, record.updatedAt);
  }

  async sendTest(
    raw: unknown,
    actor: Actor,
    _sender?: EmailSender,
  ): Promise<RuntimePolicyView> {
    const input = object(raw, "request body");
    const stored = await this.loadStored();
    const current = stored?.settings ?? this.defaults;
    const expectedVersion = nonNegativeInteger(
      input["expectedVersion"],
      "expectedVersion",
    );
    if (expectedVersion !== (stored?.version ?? 0)) conflict();
    validateEmail(current.email);
    if (current.email.provider === "disabled")
      invalid("email provider must be enabled", "email.provider");
    const recipient =
      typeof input["recipient"] === "string"
        ? input["recipient"].trim().toLowerCase()
        : "";
    if (!isValidEmail(recipient))
      invalid("recipient must be a valid email address", "recipient");
    await (_sender ?? buildEmailSender(current.email)).sendVerificationCode({
      to: recipient,
      code: "000000",
      interactionUid: `runtime-policy-test-${randomUUID()}`,
      expiresInSeconds: current.policy.emailVerifyCodeTtlSeconds,
    });
    const verifiedAt = this.now().toISOString();
    const next = {
      ...current,
      email: { ...current.email, lastVerifiedAt: verifiedAt },
    };
    const record = await this.save(next, expectedVersion, verifiedAt, {
      actorSubjectId: actor.subjectId,
      action: "runtime_policy.verified",
      changedFields: ["email.verification"],
      previousValues: auditValues(current),
      newValues: auditValues(next),
      secretsReplaced: { resendApiKey: false, smtpPassword: false },
      ...(actor.sourceIp ? { sourceIp: actor.sourceIp } : {}),
      createdAt: verifiedAt,
    });
    return this.toView(next, record.version, record.updatedAt);
  }

  listAuditLogs(limit = 50) {
    return this.store.listAppSettingAuditLogs(RUNTIME_POLICY_KEY, limit);
  }

  private async migrateLegacyEmail() {
    const legacy = await this.store.getAppSetting(LEGACY_EMAIL_SETTINGS_KEY);
    if (!legacy) return null;
    const email = await decryptJson<EmailSettings>(
      this.encryptionSecret,
      legacy.valueCiphertext,
    );
    const settings = {
      ...structuredClone(this.defaults),
      email: normalizeEmail(email),
    };
    const updatedAt = this.now().toISOString();
    const record = await this.save(settings, 0, updatedAt, {
      actorSubjectId: null,
      action: "runtime_policy.migrated",
      changedFields: ["email"],
      previousValues: {},
      newValues: auditValues(settings),
      secretsReplaced: {
        resendApiKey: Boolean(email.resend?.apiKey),
        smtpPassword: Boolean(email.smtp?.password),
      },
      createdAt: updatedAt,
    });
    return { settings, version: record.version, updatedAt: record.updatedAt };
  }

  private async loadStored() {
    const record = await this.store.getAppSetting(RUNTIME_POLICY_KEY);
    if (!record) return null;
    const settings = await decryptJson<RuntimePolicy>(
      this.encryptionSecret,
      record.valueCiphertext,
    );
    validatePolicy(settings.policy);
    validateEmail(settings.email);
    return { settings, version: record.version, updatedAt: record.updatedAt };
  }

  private async save(
    settings: RuntimePolicy,
    expectedVersion: number,
    updatedAt: string,
    audit: Omit<
      AppSettingAuditRecord,
      "id" | "settingKey" | "previousVersion" | "newVersion"
    >,
  ) {
    const result = await this.store.saveAppSetting({
      key: RUNTIME_POLICY_KEY,
      valueCiphertext: await encryptJson(this.encryptionSecret, settings),
      expectedVersion,
      updatedAt,
      audit,
    });
    if (result.status === "version_conflict") conflict();
    return result.record;
  }

  private toView(
    settings: RuntimePolicy,
    version: number,
    updatedAt: string | null,
  ): RuntimePolicyView {
    return {
      policy: settings.policy,
      email: emailView(settings.email, version, updatedAt),
      version,
      loadedVersion: this.loadedVersion,
      restartRequired: version !== this.loadedVersion,
      updatedAt,
    };
  }
}

type Actor = { subjectId: string; sourceIp?: string };

export function defaultRuntimePolicy(config: OidcOpConfig): RuntimePolicy {
  return {
    policy: Object.fromEntries(
      POLICY_KEYS.map((key) => [key, config[key]]),
    ) as PolicyValues,
    email: emptyEmailSettings(),
  };
}

function parsePolicy(value: unknown): PolicyValues {
  const input = object(value, "policy");
  const output: Record<string, number | boolean> = {};
  for (const key of POLICY_KEYS) {
    const current = input[key];
    output[key] = key.endsWith("AdminExempt")
      ? booleanValue(current, key)
      : nonNegativeInteger(current, key);
  }
  return output as PolicyValues;
}

function validatePolicy(policy: PolicyValues) {
  for (const key of POLICY_KEYS) {
    const value = policy[key];
    if (
      typeof value === "number" &&
      (key === "clientSecretDefaultGraceSeconds" ||
      key === "clientSecretRotateMinimumIntervalSeconds"
        ? value < 0
        : value <= 0)
    ) {
      invalid(
        `${key} must be a ${key.includes("Grace") || key.includes("Minimum") ? "non-negative" : "positive"} integer`,
        key,
      );
    }
  }
  if (policy.sessionIdleTtlSeconds > policy.sessionTtlSeconds)
    invalid(
      "session idle TTL must not exceed session TTL",
      "sessionIdleTtlSeconds",
    );
  if (policy.csrfTokenTtlSeconds > policy.interactionTtlSeconds)
    invalid(
      "CSRF token TTL must not exceed interaction TTL",
      "csrfTokenTtlSeconds",
    );
  if (policy.grantTtlSeconds < policy.refreshTokenTtlSeconds)
    invalid(
      "grant TTL must not be shorter than refresh token TTL",
      "grantTtlSeconds",
    );
  if (
    policy.managementClientMaxPendingPerProject >
    policy.managementClientMaxPerProject
  )
    invalid(
      "pending clients per project must not exceed total",
      "managementClientMaxPendingPerProject",
    );
  if (
    policy.managementClientMaxPendingPerSubject >
    policy.managementClientMaxPerSubject
  )
    invalid(
      "pending clients per subject must not exceed total",
      "managementClientMaxPendingPerSubject",
    );
  if (
    policy.clientSecretDefaultGraceSeconds > policy.clientSecretMaxGraceSeconds
  )
    invalid(
      "default secret grace must not exceed maximum",
      "clientSecretDefaultGraceSeconds",
    );
}

function mergeEmail(current: EmailSettings, raw: unknown): EmailSettings {
  const input = object(raw, "email");
  const provider = input["provider"];
  if (provider !== "resend" && provider !== "smtp" && provider !== "disabled")
    invalid("invalid email provider", "email.provider");
  const resend = object(input["resend"] ?? {}, "email.resend");
  const smtp = object(input["smtp"] ?? {}, "email.smtp");
  const next: EmailSettings = {
    provider,
    resend: {
      apiKey: secret(resend["apiKey"], current.resend.apiKey),
      from: optionalText(resend["from"], current.resend.from),
    },
    smtp: {
      host: optionalText(smtp["host"], current.smtp.host),
      port:
        smtp["port"] === null || smtp["port"] === ""
          ? undefined
          : smtp["port"] === undefined
            ? current.smtp.port
            : nonNegativeInteger(smtp["port"], "email.smtp.port"),
      secure:
        smtp["secure"] === undefined
          ? current.smtp.secure
          : booleanValue(smtp["secure"], "email.smtp.secure"),
      user: optionalText(smtp["user"], current.smtp.user),
      password: secret(smtp["password"], current.smtp.password),
      from: optionalText(smtp["from"], current.smtp.from),
    },
  };
  return JSON.stringify({ ...current, lastVerifiedAt: undefined }) ===
    JSON.stringify(next) && current.lastVerifiedAt
    ? { ...next, lastVerifiedAt: current.lastVerifiedAt }
    : next;
}

function normalizeEmail(email: EmailSettings): EmailSettings {
  return {
    provider:
      email?.provider === "resend" || email?.provider === "smtp"
        ? email.provider
        : "disabled",
    resend: email?.resend ?? {},
    smtp: email?.smtp ?? {},
    ...(typeof email?.lastVerifiedAt === "string"
      ? { lastVerifiedAt: email.lastVerifiedAt }
      : {}),
  };
}

function validateEmail(email: EmailSettings) {
  if (
    email.provider === "resend" &&
    (!email.resend.apiKey || !email.resend.from)
  )
    invalid("Resend API key and sender are required", "email.resend");
  if (
    email.provider === "smtp" &&
    (!email.smtp.host || !email.smtp.port || !email.smtp.from)
  )
    invalid("SMTP host, port and sender are required", "email.smtp");
  if (email.smtp.port && email.smtp.port > 65535)
    invalid("SMTP port must not exceed 65535", "email.smtp.port");
}

function emailView(
  settings: EmailSettings,
  version: number,
  updatedAt: string | null,
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
    source: version ? "database" : "default",
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

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${field} must be an object`, field);
  return value as Record<string, unknown>;
}
function nonNegativeInteger(value: unknown, field: string) {
  if (!Number.isInteger(value) || Number(value) < 0)
    invalid(`${field} must be a non-negative integer`, field);
  return Number(value);
}
function booleanValue(value: unknown, field: string) {
  if (typeof value !== "boolean") invalid(`${field} must be a boolean`, field);
  return value;
}
function optionalText(value: unknown, current?: string) {
  if (value === undefined) return current;
  if (value === null) return undefined;
  if (typeof value !== "string") invalid("value must be a string");
  return value.trim() || undefined;
}
function secret(value: unknown, current?: string) {
  return typeof value === "string" && value.trim() ? value.trim() : current;
}
function secretChanges(raw: unknown) {
  const email = object(raw, "email");
  const resend = object(email["resend"] ?? {}, "email.resend");
  const smtp = object(email["smtp"] ?? {}, "email.smtp");
  return {
    resendApiKey: Boolean(
      typeof resend["apiKey"] === "string" && resend["apiKey"].trim(),
    ),
    smtpPassword: Boolean(
      typeof smtp["password"] === "string" && smtp["password"].trim(),
    ),
  };
}
function auditValues(settings: RuntimePolicy) {
  return {
    policy: settings.policy,
    email: {
      provider: settings.email.provider,
      resend: { from: settings.email.resend.from },
      smtp: {
        host: settings.email.smtp.host,
        port: settings.email.smtp.port,
        secure: settings.email.smtp.secure,
        user: settings.email.smtp.user,
        from: settings.email.smtp.from,
      },
      verifiedAt: settings.email.lastVerifiedAt ?? null,
    },
  };
}
function changedFields(before: RuntimePolicy, after: RuntimePolicy) {
  return ["policy", "email"].filter(
    (key) =>
      JSON.stringify(before[key as keyof RuntimePolicy]) !==
      JSON.stringify(after[key as keyof RuntimePolicy]),
  );
}
function conflict(): never {
  throw new ClientManagementError(
    409,
    "version_conflict",
    "runtime policy changed concurrently; reload and retry",
  );
}
function invalid(message: string, field?: string): never {
  throw new ClientManagementError(400, "invalid_request", message, field);
}
