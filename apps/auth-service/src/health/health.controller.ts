import type { Response } from "express";
import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";
import { PostgresService } from "../persistence/postgres.service.js";
import { RedisService } from "../persistence/redis.service.js";

@Controller()
export class HealthController {
  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PostgresService) private readonly postgres: PostgresService,
    @Inject(RedisService) private readonly redis: RedisService
  ) {}

  @Get("/health/live")
  getLiveness() {
    return {
      status: "ok",
      env: this.config.appEnv
    };
  }

  @Get("/health/ready")
  async getReadiness(@Res({ passthrough: true }) response: Response) {
    const databaseReady = await this.postgres.checkReadiness();
    const redisRequired = this.redis.isRequiredForReadiness();
    const redisReady = redisRequired ? await this.redis.checkReadiness() : true;
    const workerReady =
      this.config.workerMode === "external"
        ? await this.postgres.hasFreshWorkerHeartbeat(
            new Date(Date.now() - this.config.workerHeartbeatStaleMs).toISOString()
          )
        : true;
    const databaseMode = databaseReady
      ? "postgres"
      : this.config.databaseRequired
        ? "unavailable"
        : "memory";
    const ready = (databaseReady || databaseMode === "memory") && redisReady && workerReady;

    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ready ? "ready" : "not_ready",
      env: this.config.appEnv,
      worker_mode: this.config.workerMode,
      worker: this.config.workerMode === "external" ? (workerReady ? "ready" : "unavailable") : "embedded",
      provider: this.config.authProvider,
      database: databaseMode,
      redis: redisReady ? "ready" : redisRequired ? "unavailable" : "optional"
    };
  }

  @Get("/health")
  async getHealth(@Res({ passthrough: true }) response: Response) {
    return this.getReadiness(response);
  }
}
