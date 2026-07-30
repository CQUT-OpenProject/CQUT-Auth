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

test("getSecretParam splits long passwords into 30-char encrypted chunks correctly", () => {
  const p30 = getSecretParam("a".repeat(30));
  const parsed30 = JSON.parse(decodeURIComponent(p30)) as string[];
  assert.equal(parsed30.length, 1);

  const p60 = getSecretParam("a".repeat(60));
  const parsed60 = JSON.parse(decodeURIComponent(p60)) as string[];
  assert.equal(parsed60.length, 2);

  const p61 = getSecretParam("a".repeat(61));
  const parsed61 = JSON.parse(decodeURIComponent(p61)) as string[];
  assert.equal(parsed61.length, 3);
});
