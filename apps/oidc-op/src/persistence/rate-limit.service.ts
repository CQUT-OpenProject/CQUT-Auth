import Redis from "ioredis";
import type { OidcOpConfig } from "../config.js";

type MemoryCounter = {
  count: number;
  expiresAt: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type RateLimitMode = "redis" | "memory" | "fail-closed";

export class RateLimitUnavailableError extends Error {
  constructor(message = "rate limit backend unavailable") {
    super(message);
  }
}

export class RateLimitService {
  private readonly logger = console;
  private readonly memory = new Map<string, MemoryCounter>();
  private redis: Redis | undefined;
  private mode: RateLimitMode = "memory";
  private memoryCleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: OidcOpConfig) {}

  async init() {
    if (!this.config.redisUrl) {
      this.mode = "memory";
      this.startMemoryCleanup();
      return;
    }
    try {
      this.redis = new Redis(this.config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null
      });
      this.redis.on("error", () => undefined);
      await this.redis.connect();
      await this.redis.ping();
      this.mode = "redis";
    } catch (error) {
      this.logger.warn(
        `redis unavailable for oidc rate limiting, falling back to memory: ${error instanceof Error ? error.message : "unknown error"}`
      );
      this.redis?.disconnect(false);
      this.redis = undefined;
      if (this.config.rateLimitFailClosed) {
        this.mode = "fail-closed";
        this.memory.clear();
        return;
      }
      this.mode = "memory";
      this.startMemoryCleanup();
    }
  }

  async consume(key: string, max: number, windowSeconds: number): Promise<RateLimitDecision> {
    if (this.mode === "redis" && this.redis) {
      try {
        const result = (await this.redis.eval(
          `
          local current = redis.call("INCR", KEYS[1])
          if current == 1 then
            redis.call("EXPIRE", KEYS[1], ARGV[1])
          end
          local ttl = redis.call("TTL", KEYS[1])
          return { current, ttl }
          `,
          1,
          key,
          windowSeconds
        )) as [number | string, number | string];
        const count = Number(result[0]);
        const ttl = Math.max(1, Number(result[1]));
        return {
          allowed: count <= max,
          retryAfterSeconds: ttl
        };
      } catch (error) {
        this.logger.warn(
          `redis rate limiting unavailable during consume: ${error instanceof Error ? error.message : "unknown error"}`
        );
        if (this.config.rateLimitFailClosed) {
          this.mode = "fail-closed";
          throw new RateLimitUnavailableError();
        }
        this.mode = "memory";
        this.startMemoryCleanup();
      }
    }

    if (this.mode === "fail-closed") {
      throw new RateLimitUnavailableError();
    }

    const now = Date.now();
    const existing = this.memory.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.memory.set(key, {
        count: 1,
        expiresAt: now + windowSeconds * 1000
      });
      return {
        allowed: true,
        retryAfterSeconds: windowSeconds
      };
    }
    existing.count += 1;
    this.evictIfOverCapacity();
    return {
      allowed: existing.count <= max,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000))
    };
  }

  async reset(key: string) {
    if (this.mode === "redis" && this.redis) {
      await this.redis.del(key);
      return;
    }
    if (this.mode === "fail-closed") {
      throw new RateLimitUnavailableError();
    }
    this.memory.delete(key);
  }

  async checkReadiness() {
    if (this.mode === "fail-closed") {
      return false;
    }
    if (!this.redis || this.mode !== "redis") {
      return true;
    }
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    if (this.memoryCleanupTimer) {
      clearInterval(this.memoryCleanupTimer);
      this.memoryCleanupTimer = undefined;
    }
    if (this.redis) {
      this.redis.disconnect(false);
      this.redis = undefined;
    }
  }

  private startMemoryCleanup() {
    if (this.memoryCleanupTimer) {
      return;
    }
    this.memoryCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, counter] of this.memory.entries()) {
        if (counter.expiresAt <= now) {
          this.memory.delete(key);
        }
      }
      this.evictIfOverCapacity();
    }, this.config.rateLimitMemoryCleanupIntervalSeconds * 1000);
    this.memoryCleanupTimer.unref?.();
  }

  private evictIfOverCapacity() {
    const overflow = this.memory.size - this.config.rateLimitMemoryMaxKeys;
    if (overflow <= 0) {
      return;
    }
    const candidates = [...this.memory.entries()]
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
      .slice(0, overflow);
    for (const [key] of candidates) {
      this.memory.delete(key);
    }
  }
}
