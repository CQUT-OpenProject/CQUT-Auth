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

export class RateLimitService {
  private readonly logger = console;
  private readonly memory = new Map<string, MemoryCounter>();
  private redis: Redis | undefined;

  constructor(private readonly config: OidcOpConfig) {}

  async init() {
    if (!this.config.redisUrl) {
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
    } catch (error) {
      this.logger.warn(
        `redis unavailable for oidc rate limiting, falling back to memory: ${error instanceof Error ? error.message : "unknown error"}`
      );
      this.redis?.disconnect(false);
      this.redis = undefined;
    }
  }

  async consume(key: string, max: number, windowSeconds: number): Promise<RateLimitDecision> {
    if (this.redis) {
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
    return {
      allowed: existing.count <= max,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000))
    };
  }

  async reset(key: string) {
    if (this.redis) {
      await this.redis.del(key);
      return;
    }
    this.memory.delete(key);
  }

  async checkReadiness() {
    if (!this.redis) {
      return true;
    }
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}
