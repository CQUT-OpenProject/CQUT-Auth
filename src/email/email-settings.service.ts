import { decryptJson, encryptJson } from "../crypto.js";
import { ClientManagementError } from "../management/management-error.js";
import type { AppSettingsRepository } from "../persistence/contracts.js";
import {
  EMAIL_SETTINGS_KEY,
  emptyEmailSettings,
  type EmailProviderKind,
  type EmailSettings,
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

type EmailSettingsUpdateInput = {
  provider?: unknown;
  resend?: {
    apiKey?: unknown;
    from?: unknown;
  };
  smtp?: {
    host?: unknown;
    port?: unknown;
    secure?: unknown;
    user?: unknown;
    password?: unknown;
    from?: unknown;
  };
};

/**
 * Reads/writes the encrypted email settings row and exposes both a redacted
 * view (for the management API) and the effective settings (for the sender).
 * Secrets are kept out of the API surface entirely; blank secret fields on
 * update are treated as "keep the currently stored value".
 */
export class EmailSettingsService {
  constructor(
    private readonly store: Pick<
      AppSettingsRepository,
      "getAppSetting" | "upsertAppSetting"
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
    const settings = stored?.settings ?? this.envDerivedSettings();
    return toView(settings, stored?.updatedAt ?? null);
  }

  async update(input: EmailSettingsUpdateInput): Promise<EmailSettingsView> {
    const current = (await this.loadStored())?.settings ?? emptyEmailSettings();
    const merged = mergeSettings(current, input);
    validate(merged);
    const updatedAt = this.now().toISOString();
    const record = await this.store.upsertAppSetting({
      key: EMAIL_SETTINGS_KEY,
      valueCiphertext: await encryptJson(this.encryptionSecret, merged),
      updatedAt,
    });
    return toView(merged, record.updatedAt);
  }

  private async loadStored(): Promise<{
    settings: EmailSettings;
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
  };
}

function mergeSettings(
  current: EmailSettings,
  input: EmailSettingsUpdateInput,
): EmailSettings {
  const provider = input.provider;
  if (!PROVIDER_KINDS.includes(provider as EmailProviderKind)) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      "provider must be one of resend, smtp, disabled",
      "provider",
    );
  }
  const resendInput = input.resend ?? {};
  const smtpInput = input.smtp ?? {};
  return {
    provider: provider as EmailProviderKind,
    resend: {
      // Blank/omitted secret keeps the stored key; non-empty replaces it.
      apiKey: keepSecret(resendInput.apiKey, current.resend.apiKey),
      from: optionalString(resendInput.from, current.resend.from, "resend.from"),
    },
    smtp: {
      host: optionalString(smtpInput.host, current.smtp.host, "smtp.host"),
      port: optionalPort(smtpInput.port, current.smtp.port),
      secure:
        smtpInput.secure === undefined
          ? current.smtp.secure
          : Boolean(smtpInput.secure),
      user: optionalString(smtpInput.user, current.smtp.user, "smtp.user"),
      password: keepSecret(smtpInput.password, current.smtp.password),
      from: optionalString(smtpInput.from, current.smtp.from, "smtp.from"),
    },
  };
}

function keepSecret(
  next: unknown,
  current: string | undefined,
): string | undefined {
  if (next === undefined || next === null) {
    return current;
  }
  if (typeof next !== "string") {
    return current;
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
    updatedAt,
  };
}
