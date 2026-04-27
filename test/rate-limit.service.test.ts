import assert from "node:assert/strict";
import test from "node:test";
import type { OidcOpConfig } from "../src/config.js";
import { RateLimitService } from "../src/persistence/rate-limit.service.js";

function createConfig(overrides: Partial<OidcOpConfig> = {}): OidcOpConfig {
  return {
    redisUrl: undefined,
    rateLimitFailClosed: false,
    rateLimitMemoryMaxKeys: 2,
    rateLimitMemoryCleanupIntervalSeconds: 3600,
    ...overrides
  } as unknown as OidcOpConfig;
}

test("memory fallback evicts oldest key when capacity is exceeded on new insert", async () => {
  const service = new RateLimitService(createConfig({ rateLimitMemoryMaxKeys: 2 }));
  await service.init();

  try {
    await service.consume("key-1", 10, 60);
    await service.consume("key-2", 10, 60);
    await service.consume("key-3", 10, 60);

    const key2 = await service.consume("key-2", 1, 60);
    const key1 = await service.consume("key-1", 1, 60);

    assert.equal(key2.allowed, false);
    assert.equal(key1.allowed, true);
  } finally {
    await service.close();
  }
});

test("memory fallback keeps FIFO order even when an old key is hit again", async () => {
  const service = new RateLimitService(createConfig({ rateLimitMemoryMaxKeys: 2 }));
  await service.init();

  try {
    await service.consume("key-1", 10, 60);
    await service.consume("key-2", 10, 60);
    await service.consume("key-1", 10, 60);
    await service.consume("key-3", 10, 60);

    const key1 = await service.consume("key-1", 1, 60);

    assert.equal(key1.allowed, true);
  } finally {
    await service.close();
  }
});

test("expired counters and FIFO eviction can coexist without stale key retention", async () => {
  const service = new RateLimitService(createConfig({ rateLimitMemoryMaxKeys: 1 }));
  await service.init();

  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;

  try {
    await service.consume("expired", 10, 1);
    now = 12_500;

    await service.consume("live", 10, 60);

    const live = await service.consume("live", 1, 60);
    const expired = await service.consume("expired", 1, 60);

    assert.equal(live.allowed, false);
    assert.equal(expired.allowed, true);
  } finally {
    Date.now = originalNow;
    await service.close();
  }
});
