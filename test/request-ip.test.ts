import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrustedRequestIp } from "../src/request-ip.js";

test("resolveTrustedRequestIp trusts forwarded-for only from configured proxy cidrs", () => {
  const config = {
    trustProxyHops: 1,
    trustedProxyCidrs: ["127.0.0.1/32", "10.0.0.0/8", "::1/128"]
  };

  assert.equal(
    resolveTrustedRequestIp(config, {
      headers: { "x-forwarded-for": "198.51.100.10" },
      remoteAddress: "127.0.0.1"
    }),
    "198.51.100.10"
  );
  assert.equal(
    resolveTrustedRequestIp(config, {
      headers: { "x-forwarded-for": "198.51.100.10" },
      remoteAddress: "203.0.113.250"
    }),
    "203.0.113.250"
  );
});

test("resolveTrustedRequestIp still uses the configured trusted hop", () => {
  assert.equal(
    resolveTrustedRequestIp(
      { trustProxyHops: 1, trustedProxyCidrs: ["127.0.0.1/32"] },
      {
        headers: { "x-forwarded-for": "203.0.113.1, 198.51.100.50" },
        remoteAddress: "127.0.0.1"
      }
    ),
    "198.51.100.50"
  );
});

test("resolveTrustedRequestIp supports ipv6 trusted proxy cidrs", () => {
  assert.equal(
    resolveTrustedRequestIp(
      { trustProxyHops: 1, trustedProxyCidrs: ["::1/128", "fc00::/7"] },
      {
        headers: { "x-forwarded-for": "198.51.100.20" },
        remoteAddress: "::1"
      }
    ),
    "198.51.100.20"
  );
});
