import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";
import type { VerificationRequest } from "../common/types.js";

type FixedWindowCounter = {
  count: number;
  ttlSeconds: number;
};

type RedisConnection = {
  connect(): Promise<void>;
  ping(): Promise<string>;
  disconnect(reconnect?: boolean): void;
  on(event: "error", listener: (error: unknown) => void): unknown;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    numKeys: number,
    key: string,
    ttlSeconds: number
  ): Promise<[number | string, number | string]>;
};

@Injectable()
export class RedisService implements OnModuleInit {
  private readonly logger = new Logger(RedisService.name);
  private readonly requestStore = new Map<string, VerificationRequest>();
  private redis: RedisConnection | undefined;

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  async onModuleInit() {
    if (!this.config.redisUrl) {
      this.logger.warn("REDIS_URL not configured, falling back to in-memory state store");
      return;
    }

    let client: RedisConnection | undefined;

    try {
      const { default: Redis } = await import("ioredis");
      const RedisCtor = Redis as unknown as new (
        url: string,
        options: {
          lazyConnect: boolean;
          maxRetriesPerRequest: number;
          retryStrategy: () => null;
        }
      ) => RedisConnection;
      client = new RedisCtor(this.config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null
      });
      client.on("error", () => undefined);
      await client.connect();
      await client.ping();
      this.redis = client;
    } catch (error) {
      if (this.config.redisRequiredAtStartup) {
        throw error;
      }
      this.logger.warn(
        `REDIS_URL is configured but unavailable, falling back to in-memory state store: ${error instanceof Error ? error.message : "unknown error"}`
      );
      client?.disconnect(false);
    }
  }

  async saveVerificationRequest(requestRecord: VerificationRequest, ttlSeconds: number) {
    this.requestStore.set(requestRecord.requestId, requestRecord);
    if (this.redis) {
      await this.redis.set(`verify:${requestRecord.requestId}`, JSON.stringify(requestRecord), "EX", ttlSeconds);
    }
  }

  async getVerificationRequest(requestId: string): Promise<VerificationRequest | null> {
    if (this.redis) {
      const raw = await this.redis.get(`verify:${requestId}`);
      return raw ? (JSON.parse(raw) as VerificationRequest) : null;
    }
    return this.requestStore.get(requestId) ?? null;
  }

  hasRedis() {
    return !!this.redis;
  }

  isRequiredForReadiness() {
    return this.config.redisRequiredForReadiness;
  }

  async checkReadiness() {
    if (!this.redis) {
      return false;
    }
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  async incrementFixedWindowCounter(key: string, ttlSeconds: number): Promise<FixedWindowCounter> {
    if (!this.redis) {
      throw new Error("redis is not configured");
    }

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
      ttlSeconds
    )) as [number | string, number | string];

    const count = Number(result[0]);
    const ttl = Number(result[1]);
    return {
      count,
      ttlSeconds: ttl > 0 ? ttl : ttlSeconds
    };
  }
}
