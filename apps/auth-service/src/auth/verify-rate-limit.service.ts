import { Inject, Injectable } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";
import { RedisService } from "../persistence/redis.service.js";

type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type InMemoryWindow = {
  count: number;
  resetAt: number;
};

@Injectable()
export class VerifyRateLimitService {
  private readonly windows = new Map<string, InMemoryWindow>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(RedisService) private readonly redis: RedisService
  ) {}

  async consume(clientId: string): Promise<RateLimitDecision> {
    if (!this.config.verifyRateLimitEnabled) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const limit = this.config.verifyRateLimitMax;
    const windowSeconds = this.config.verifyRateLimitWindowSeconds;
    if (limit <= 0 || windowSeconds <= 0) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (this.redis.hasRedis()) {
      return this.consumeRedis(clientId, limit, windowSeconds);
    }
    return this.consumeMemory(clientId, limit, windowSeconds);
  }

  private async consumeRedis(
    clientId: string,
    limit: number,
    windowSeconds: number
  ): Promise<RateLimitDecision> {
    const counter = await this.redis.incrementFixedWindowCounter(
      `rate-limit:verify:${clientId}`,
      windowSeconds
    );
    if (counter.count <= limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: counter.ttlSeconds > 0 ? counter.ttlSeconds : windowSeconds
    };
  }

  private consumeMemory(clientId: string, limit: number, windowSeconds: number): RateLimitDecision {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const current = this.windows.get(clientId);

    if (!current || current.resetAt <= now) {
      this.windows.set(clientId, {
        count: 1,
        resetAt: now + windowMs
      });
      this.compactExpiredWindows(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    current.count += 1;
    this.windows.set(clientId, current);
    if (current.count <= limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    };
  }

  private compactExpiredWindows(now: number) {
    for (const [clientId, window] of this.windows.entries()) {
      if (window.resetAt <= now) {
        this.windows.delete(clientId);
      }
    }
  }
}
