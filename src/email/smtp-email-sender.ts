import nodemailer, { type Transporter } from "nodemailer";
import type { EmailSender, SendVerificationCodeInput } from "./email-sender.js";
import { renderVerificationEmail } from "./verification-template.js";

export type SmtpEmailSenderOptions = {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
};

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(options: SmtpEmailSenderOptions) {
    this.from = options.from;
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth:
        options.user && options.password
          ? { user: options.user, pass: options.password }
          : undefined,
    });
  }

  async sendVerificationCode(input: SendVerificationCodeInput): Promise<void> {
    const { subject, text, html } = renderVerificationEmail(input);
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject,
      text,
      html,
    });
  }
}
