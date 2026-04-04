import Redis from "ioredis";

export type DemoSession = {
  sessionId: string;
  pendingAuth?: {
    state: string;
    nonce: string;
    codeVerifier: string;
  } | undefined;
  idToken?: string | undefined;
  userInfo?: Record<string, unknown> | undefined;
};

export interface DemoSessionStore {
  ping(): Promise<void>;
  get(sessionId: string): Promise<DemoSession | null>;
  set(session: DemoSession): Promise<void>;
  destroy(sessionId: string): Promise<void>;
}

type RedisDemoSessionStoreOptions = {
  redisUrl: string;
  ttlSeconds: number;
  keyPrefix: string;
};

export class RedisDemoSessionStore implements DemoSessionStore {
  private readonly redis: {
    on(event: string, listener: (...args: unknown[]) => void): void;
    connect(): Promise<void>;
    ping(): Promise<string>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
    del(key: string): Promise<number>;
  };

  constructor(private readonly options: RedisDemoSessionStoreOptions) {
    const RedisClient = Redis as unknown as new (
      redisUrl: string,
      options: Record<string, unknown>
    ) => RedisDemoSessionStore["redis"];
    this.redis = new RedisClient(options.redisUrl, {
      lazyConnect: true,
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });
    this.redis.on("error", () => undefined);
  }

  async ping() {
    await this.redis.connect();
    await this.redis.ping();
  }

  async get(sessionId: string): Promise<DemoSession | null> {
    const encoded = await this.redis.get(this.key(sessionId));
    if (!encoded) {
      return null;
    }
    const parsed = JSON.parse(encoded) as DemoSession;
    if (!parsed || typeof parsed.sessionId !== "string") {
      return null;
    }
    return parsed;
  }

  async set(session: DemoSession): Promise<void> {
    await this.redis.set(this.key(session.sessionId), JSON.stringify(session), "EX", this.options.ttlSeconds);
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId));
  }

  private key(sessionId: string) {
    return `${this.options.keyPrefix}${sessionId}`;
  }
}
