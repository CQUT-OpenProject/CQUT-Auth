import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeHtml,
  isValidEmail,
  isValidEmailFromAddress,
  normalizeEmailFromAddress,
  parseCookies,
  parseScope,
} from "../src/utils.js";

test("parseCookies parses key-value pairs safely and prevents prototype pollution", () => {
  const parsed = parseCookies("sid=abc123; theme=dark; __proto__=polluted");

  assert.equal(parsed["sid"], "abc123");
  assert.equal(parsed["theme"], "dark");
  assert.equal(
    Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
    false,
  );
  assert.equal(({} as Record<string, string>)["polluted"], undefined);
});

test("parseCookies returns empty object for undefined or empty raw input", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
});

test("parseScope splits and trims space-delimited scope string", () => {
  assert.deepEqual(parseScope("openid profile  email "), [
    "openid",
    "profile",
    "email",
  ]);
  assert.deepEqual(parseScope(undefined), []);
});

test("escapeHtml escapes special HTML characters", () => {
  assert.equal(
    escapeHtml("<script>alert('xss & \"test\"')</script>"),
    "&lt;script&gt;alert(&#39;xss &amp; &quot;test&quot;&#39;)&lt;/script&gt;",
  );
});

test("email validators and normalizers handle edge cases correctly", () => {
  assert.equal(isValidEmail("user@example.com"), true);
  assert.equal(isValidEmail("invalid-email"), false);

  assert.equal(
    normalizeEmailFromAddress("Sender <user@example.com>"),
    "Sender <user@example.com>",
  );
  assert.equal(
    normalizeEmailFromAddress("Sender<user@example.com>"),
    "Sender <user@example.com>",
  );

  assert.equal(isValidEmailFromAddress("Sender <user@example.com>"), true);
  assert.equal(isValidEmailFromAddress("user@example.com"), true);
  assert.equal(isValidEmailFromAddress("Invalid <>"), false);
});
