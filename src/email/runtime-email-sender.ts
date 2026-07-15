import type { EmailSender, SendVerificationCodeInput } from "./email-sender.js";
import type { EmailSettings } from "./email-settings.js";
import { ResendEmailSender } from "./resend-email-sender.js";
import { SmtpEmailSender } from "./smtp-email-sender.js";

export class DisabledEmailSender implements EmailSender {
  async sendVerificationCode(_input: SendVerificationCodeInput): Promise<void> {
    throw new Error("email verification sender is not configured");
  }
}

type EmailSettingsSource = {
  loadEffective(): Promise<EmailSettings>;
};

/**
 * Dispatches each send to the provider currently selected in the runtime
 * settings (Resend / SMTP / disabled). The concrete transport is rebuilt only
 * when the effective settings change, so admins can switch providers from the
 * management panel without a restart.
 */
export class RuntimeEmailSender implements EmailSender {
  private cached: { signature: string; sender: EmailSender } | undefined;

  constructor(private readonly settingsSource: EmailSettingsSource) {}

  async sendVerificationCode(input: SendVerificationCodeInput): Promise<void> {
    const settings = await this.settingsSource.loadEffective();
    const sender = this.resolveSender(settings);
    await sender.sendVerificationCode(input);
  }

  private resolveSender(settings: EmailSettings): EmailSender {
    // Signature includes secrets but never leaves memory; it only detects when
    // the transport must be rebuilt.
    const signature = JSON.stringify(settings);
    if (this.cached?.signature === signature) {
      return this.cached.sender;
    }
    const sender = buildEmailSender(settings);
    this.cached = { signature, sender };
    return sender;
  }
}

export function buildEmailSender(settings: EmailSettings): EmailSender {
  if (settings.provider === "resend") {
    if (settings.resend.apiKey && settings.resend.from) {
      return new ResendEmailSender({
        apiKey: settings.resend.apiKey,
        from: settings.resend.from,
      });
    }
    return new DisabledEmailSender();
  }
  if (settings.provider === "smtp") {
    if (settings.smtp.host && settings.smtp.port && settings.smtp.from) {
      return new SmtpEmailSender({
        host: settings.smtp.host,
        port: settings.smtp.port,
        secure: settings.smtp.secure ?? false,
        user: settings.smtp.user,
        password: settings.smtp.password,
        from: settings.smtp.from,
      });
    }
    return new DisabledEmailSender();
  }
  return new DisabledEmailSender();
}
