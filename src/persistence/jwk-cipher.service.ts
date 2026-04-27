import { decryptJson, encryptJson } from "../crypto.js";

export class JwkCipherServiceImpl {
  constructor(private readonly keyEncryptionSecret: string) {}

  async encryptPrivateJwk(jwk: JsonWebKey) {
    return encryptJson(this.keyEncryptionSecret, jwk);
  }

  async decryptPrivateJwk(ciphertext: string) {
    return decryptJson<JsonWebKey>(this.keyEncryptionSecret, ciphertext);
  }
}
