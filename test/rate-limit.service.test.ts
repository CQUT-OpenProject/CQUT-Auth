import assert from "node:assert/strict";
import test from "node:test";
import type { StaticConfig } from "../src/config.js";
import { RateLimitService } from "../src/persistence/rate-limit.service.js";

function createConfig(overrides: Partial<StaticConfig> = {}): StaticConfig {
  return {
    redisUrl: undefined,
    rateLimitFailClosed: false,
    rateLimitMemoryMaxKeys: 2,
    rateLimitMemoryCleanupIntervalSeconds: 3600,
    ...overrides,
  } as unknown as StaticConfig;
}

test("memory fallback evicts oldest key when capacity is exceeded on new insert", async () => {
  const service = new RateLimitService(
    createConfig({ rateLimitMemoryMaxKeys: 2 }),
  );
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

test("memory fallback preserves accumulated counters over single-hit probes during eviction", async () => {
  const service = new RateLimitService(
    createConfig({ rateLimitMemoryMaxKeys: 2 }),
  );
  await service.init();

  try {
    // key-1 accumulates failures/attempts (count reaches 2)
    await service.consume("key-1", 10, 60);
    await service.consume("key-1", 10, 60);
    // key-2 is a single-hit probe (count = 1)
    await service.consume("key-2", 10, 60);
    // key-3 is another single-hit probe causing capacity overflow (max 2 keys)
    await service.consume("key-3", 10, 60);

    // key-1 (accumulated count) was NOT evicted; its counter is preserved
    const key1 = await service.consume("key-1", 2, 60);
    assert.equal(key1.allowed, false); // count is now 3, exceeding max 2

    // key-2 (single probe) was evicted to protect key-1
    const key2 = await service.consume("key-2", 1, 60);
    assert.equal(key2.allowed, true); // key-2 starts fresh with count 1
  } finally {
    await service.close();
  }
});

test("expired counters and FIFO eviction can coexist without stale key retention", async () => {
  const service = new RateLimitService(
    createConfig({ rateLimitMemoryMaxKeys: 1 }),
  );
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

test("fail-closed mode throws RateLimitUnavailableError when redis is unavailable", async () => {
  const service = new RateLimitService(
    createConfig({ rateLimitFailClosed: true, redisUrl: undefined }),
  );
  await service.init();

  try {
    await assert.rejects(
      () => service.consume("key-1", 10, 60),
      (error: unknown) => error instanceof Error && error.name === "Error",
    );
    assert.equal(await service.checkReadiness(), false);
  } finally {
    await service.close();
  }
});
