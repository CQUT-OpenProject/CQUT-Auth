import { Resend } from "resend";
import type { EmailSender, SendVerificationCodeInput } from "./email-sender.js";

type ResendEmailSenderOptions = {
  apiKey: string;
  from: string;
};

export class ResendEmailSender implements EmailSender {
  private readonly resend: Resend;
  private readonly from: string;

  constructor(options: ResendEmailSenderOptions) {
    this.resend = new Resend(options.apiKey);
    this.from = options.from;
  }

  async sendVerificationCode(input: SendVerificationCodeInput): Promise<void> {
    const ttlMinutes = Math.max(1, Math.ceil(input.expiresInSeconds / 60));
    const nowBucket = Math.floor(Date.now() / 60_000);
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: [input.to],
      subject: "CQUT Auth 邮箱验证码",
      text: `你的验证码是 ${input.code}，${ttlMinutes} 分钟内有效。若非本人操作，请忽略本邮件。`,
      html: `<div style="margin:0;padding:24px;background:#f5f7fb;">
        <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;overflow:hidden;">
          <div style="padding:20px 24px;border-bottom:1px solid #eaecf0;">
            <h2 style="margin:0;color:#101828;font-size:22px;line-height:1.3;">CQUT Auth 邮箱验证码</h2>
            <p style="margin:8px 0 0 0;color:#667085;font-size:14px;">请在登录页面输入下方 6 位验证码完成验证。</p>
          </div>
          <div style="padding:28px 24px;">
            <p style="margin:0 0 12px 0;color:#344054;font-size:16px;">你的验证码：</p>
            <div style="font-size:32px;line-height:1.2;letter-spacing:8px;font-weight:800;color:#0f172a;background:#f8fafc;border:1px dashed #d0d5dd;border-radius:10px;padding:14px 16px;text-align:center;user-select:all;-webkit-user-select:all;">${escapeHtml(input.code)}</div>
            <p style="margin:12px 0 0 0;color:#475467;font-size:14px;">验证码 ${ttlMinutes} 分钟内有效。</p>
          </div>
          <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #eaecf0;">
            <p style="margin:0;color:#667085;font-size:12px;line-height:1.6;">若非本人操作，请忽略此邮件。</p>
          </div>
        </div>
      </div>`
    }, {
      idempotencyKey: `email-verify/${input.interactionUid}/${nowBucket}`
    });
    if (error) {
      throw new Error(`resend email send failed: ${error.message}`);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
