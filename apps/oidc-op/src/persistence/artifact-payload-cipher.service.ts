import { createHmac } from "node:crypto";
import { decryptJson, encryptJson } from "../crypto.js";

export class ArtifactPayloadCipherServiceImpl {
  constructor(private readonly encryptionSecret: string) {}

  async encryptPayload(payload: Record<string, unknown>) {
    return encryptJson(this.encryptionSecret, payload);
  }

  async decryptPayload(ciphertext: string) {
    return decryptJson<Record<string, unknown>>(this.encryptionSecret, ciphertext);
  }

  hashLookupValue(value: string) {
    return createHmac("sha256", this.encryptionSecret).update(value).digest("hex");
  }
}
