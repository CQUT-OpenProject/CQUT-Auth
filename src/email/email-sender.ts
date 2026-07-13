export type SendVerificationCodeInput = {
  to: string;
  code: string;
  interactionUid: string;
  expiresInSeconds: number;
};

export interface EmailSender {
  sendVerificationCode(input: SendVerificationCodeInput): Promise<void>;
}
