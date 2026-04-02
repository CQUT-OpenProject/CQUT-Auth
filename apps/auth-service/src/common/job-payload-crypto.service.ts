import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";
import { base64Url } from "./utils.js";

export type VerificationJobPayload = {
  account: string;
  password: string;
};

type EncryptedPayloadEnvelope = {
  iv: string;
  tag: string;
  ciphertext: string;
};

@Injectable()
export class JobPayloadCryptoService {
  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  encrypt(payload: VerificationJobPayload): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.getKey(), iv);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedPayloadEnvelope = {
      iv: base64Url(iv),
      tag: base64Url(cipher.getAuthTag()),
      ciphertext: base64Url(ciphertext)
    };
    return JSON.stringify(envelope);
  }

  decrypt(raw: string): VerificationJobPayload {
    const envelope = JSON.parse(raw) as EncryptedPayloadEnvelope;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.getKey(),
      Buffer.from(envelope.iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(plaintext) as VerificationJobPayload;
  }

  private getKey() {
    return createHash("sha256").update(this.config.jobPayloadSecret).digest();
  }
}
