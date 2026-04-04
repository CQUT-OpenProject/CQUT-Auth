import { decryptJson, encryptJson } from "../crypto.js";

export class JwkCipherServiceImpl {
  constructor(private readonly keyEncryptionSecret: string) {}

  encryptPrivateJwk(jwk: JsonWebKey) {
    return encryptJson(this.keyEncryptionSecret, jwk);
  }

  decryptPrivateJwk(ciphertext: string) {
    return decryptJson<JsonWebKey>(this.keyEncryptionSecret, ciphertext);
  }
}
