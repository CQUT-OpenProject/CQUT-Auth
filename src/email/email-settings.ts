/**
 * Runtime-editable email delivery settings. The full shape (including secrets)
 * is what gets encrypted at rest and consumed by the sender; the *View shape is
 * the redacted projection returned to the management API — secrets are never
 * echoed back, only a boolean flag indicating whether one is configured.
 */
export type EmailProviderKind = "resend" | "smtp" | "disabled";

export type ResendEmailSettings = {
  apiKey?: string | undefined;
  from?: string | undefined;
};

export type SmtpEmailSettings = {
  host?: string | undefined;
  port?: number | undefined;
  secure?: boolean | undefined;
  user?: string | undefined;
  password?: string | undefined;
  from?: string | undefined;
};

export type EmailSettings = {
  provider: EmailProviderKind;
  resend: ResendEmailSettings;
  smtp: SmtpEmailSettings;
  lastVerifiedAt?: string | undefined;
};

export type EmailSettingsSource = "database" | "default";

export type EmailSettingsView = {
  provider: EmailProviderKind;
  resend: {
    from: string;
    apiKeyConfigured: boolean;
  };
  smtp: {
    host: string;
    port: number | null;
    secure: boolean;
    user: string;
    from: string;
    passwordConfigured: boolean;
  };
  version: number;
  source: EmailSettingsSource;
  verification: {
    status: "verified" | "unverified" | "not_applicable";
    verifiedAt: string | null;
  };
  updatedAt: string | null;
};

export function emptyEmailSettings(): EmailSettings {
  return {
    provider: "disabled",
    resend: {},
    smtp: {},
  };
}
