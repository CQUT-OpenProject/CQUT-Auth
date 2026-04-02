import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SUPPORTED_SCOPES, type SupportedScope } from "@cqut/shared";
import { AppConfigService } from "../config/app-config.service.js";
import { PostgresService } from "../persistence/postgres.service.js";
import { RedisService } from "../persistence/redis.service.js";
import { sha256 } from "../common/utils.js";
import type { ClientConfig } from "../common/types.js";

@Injectable()
export class ClientService implements OnModuleInit {
  private readonly logger = new Logger(ClientService.name);

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PostgresService) private readonly postgres: PostgresService,
    @Inject(RedisService) private readonly redis: RedisService
  ) {}

  async onModuleInit() {
    this.postgres.logFallback();
    const client: ClientConfig = {
      clientId: this.config.demoClientId,
      clientSecretHash: sha256(this.config.demoClientSecret),
      allowedScopes: [...SUPPORTED_SCOPES] as SupportedScope[],
      status: "active",
      createdAt: new Date().toISOString()
    };
    await this.postgres.upsertClient(client);
    this.logger.log(
      JSON.stringify({
        event: "client_registry_ready",
        worker_mode: this.config.workerMode,
        database: this.postgres.hasDatabase() ? "postgres" : "memory",
        redis: this.redis.hasRedis() ? "redis" : "memory"
      })
    );
  }

  async authenticateClient(clientId: string, secret: string) {
    const client = await this.postgres.findClient(clientId);
    if (!client || client.status !== "active") {
      return null;
    }
    return client.clientSecretHash === sha256(secret) ? client : null;
  }

  async authenticateBasicHeader(authorization: string | string[] | undefined) {
    const raw = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!raw || !raw.startsWith("Basic ")) {
      return null;
    }

    try {
      const decoded = Buffer.from(raw.slice("Basic ".length), "base64").toString("utf8");
      const separatorIndex = decoded.indexOf(":");
      if (separatorIndex <= 0) {
        return null;
      }
      const clientId = decoded.slice(0, separatorIndex);
      const clientSecret = decoded.slice(separatorIndex + 1);
      if (!clientId || !clientSecret) {
        return null;
      }
      return this.authenticateClient(clientId, clientSecret);
    } catch {
      return null;
    }
  }
}
