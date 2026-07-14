import { Resend } from "resend";
import type { EmailSender, SendVerificationCodeInput } from "./email-sender.js";
import { renderVerificationEmail } from "./verification-template.js";

type ResendEmailSenderOptions = {
  apiKey: string;
  from: string;
  now?: () => number;
};

export class ResendEmailSender implements EmailSender {
  private readonly resend: Resend;
  private readonly from: string;
  private readonly now: () => number;

  constructor(options: ResendEmailSenderOptions) {
    this.resend = new Resend(options.apiKey);
    this.from = options.from;
    this.now = options.now ?? (() => Date.now());
  }

  async sendVerificationCode(input: SendVerificationCodeInput): Promise<void> {
    const { subject, text, html } = renderVerificationEmail(input);
    const nowBucket = Math.floor(this.now() / 60_000);
    const { error } = await this.resend.emails.send(
      {
        from: this.from,
        to: [input.to],
        subject,
        text,
        html,
      },
      {
        idempotencyKey: `email-verify/${input.interactionUid}/${nowBucket}`,
      },
    );
    if (error) {
      throw new Error(`resend email send failed: ${error.message}`);
    }
  }
}
