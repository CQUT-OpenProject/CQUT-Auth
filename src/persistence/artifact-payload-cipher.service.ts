import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
const CIPHER_PREFIX = "v1";
const CIPHER_AAD = Buffer.from("cqut-auth:oidc-artifact-payload:v2", "utf8");

export class ArtifactPayloadCipherServiceImpl {
  private readonly encryptionKey: Buffer;

  constructor(private readonly encryptionSecret: string) {
    this.encryptionKey = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(encryptionSecret, "utf8"),
        Buffer.from("cqut-auth:artifact-encryption", "utf8"),
        CIPHER_AAD,
        32,
      ),
    );
  }

  async encryptPayload(payload: Record<string, unknown>) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(CIPHER_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return [
      CIPHER_PREFIX,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  async decryptPayload(ciphertext: string) {
    const [version, ivEncoded, tagEncoded, ciphertextEncoded] =
      ciphertext.split(".");
    if (
      version !== CIPHER_PREFIX ||
      !ivEncoded ||
      !tagEncoded ||
      !ciphertextEncoded
    ) {
      throw new Error("invalid artifact ciphertext format");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(ivEncoded, "base64url"),
    );
    decipher.setAAD(CIPHER_AAD);
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const payload: unknown = JSON.parse(plaintext);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid artifact payload");
    }
    return payload as Record<string, unknown>;
  }
  hashLookupValue(value: string) {
    return createHmac("sha256", this.encryptionSecret)
      .update(value)
      .digest("hex");
  }
}
