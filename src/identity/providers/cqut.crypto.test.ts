import assert from "node:assert/strict";
import test from "node:test";
import { getSecretParam } from "./cqut.crypto.js";

test("getSecretParam returns encoded RSA chunk payload", () => {
  const sampleSecret = "sample-password-01";
  const result = getSecretParam(sampleSecret);
  const parsed = JSON.parse(decodeURIComponent(result)) as string[];

  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
  assert.match(parsed[0] ?? "", /^[A-Za-z0-9+/=]+$/);
  assert.notEqual(result, encodeURIComponent(sampleSecret));
});

test("getSecretParam splits long passwords into multiple encrypted chunks", () => {
  const result = getSecretParam("a".repeat(61));
  const parsed = JSON.parse(decodeURIComponent(result)) as string[];

  assert.equal(parsed.length, 3);
});
