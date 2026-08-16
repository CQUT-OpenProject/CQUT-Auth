import assert from "node:assert/strict";
import test from "node:test";
import {
  __cryptoTestHooks,
  createClientSecretDigest,
  decryptJson,
  encryptJson,
  verifyClientSecretDigest,
} from "../src/crypto.js";

test("derived key cache keys do not include plaintext secrets", async () => {
  const secret = "cache-key-plaintext-secret";
  __cryptoTestHooks.clearDerivedKeyCache();

  const ciphertext = await encryptJson(secret, { value: "ok" });
  await decryptJson(secret, ciphertext);

  const cacheKeys = __cryptoTestHooks.derivedKeyCacheKeys();
  assert.ok(cacheKeys.length > 0);
  assert.equal(
    cacheKeys.some((cacheKey) => cacheKey.includes(secret)),
    false,
  );
});

test("client secret verification does not cache submitted secrets", async () => {
  const secret = "submitted-client-secret";
  __cryptoTestHooks.clearDerivedKeyCache();

  const digest = await createClientSecretDigest(secret);
  assert.equal(await verifyClientSecretDigest(secret, digest), true);
  assert.equal(
    await verifyClientSecretDigest("wrong-client-secret", digest),
    false,
  );

  assert.deepEqual(__cryptoTestHooks.derivedKeyCacheKeys(), []);
});

test("decryptJson rejects malformed or invalid ciphertext formats", async () => {
  const secret = "test-secret";
  await assert.rejects(
    decryptJson(secret, "invalid$format"),
    /invalid ciphertext format/,
  );
  await assert.rejects(
    decryptJson(secret, "v1$scrypt$N=16384,r=8,p=1,keylen=32$salt$payload"),
    /unsupported ciphertext version/,
  );
});

test("verifyClientSecretDigest handles invalid or malformed digests gracefully", async () => {
  assert.equal(
    await verifyClientSecretDigest("secret", "invalid-digest"),
    false,
  );
  assert.equal(
    await verifyClientSecretDigest(
      "secret",
      "scrypt$invalid_params$salt$digest",
    ),
    false,
  );
});
