import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";
import { PostgresService } from "../persistence/postgres.service.js";
import { RedisService } from "../persistence/redis.service.js";
import { VerificationWorkerService } from "./verification-worker.service.js";

@Injectable()
export class InlineWorkerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InlineWorkerLifecycle.name);

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PostgresService) private readonly postgres: PostgresService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(VerificationWorkerService) private readonly worker: VerificationWorkerService
  ) {}

  onApplicationBootstrap() {
    if (!this.config.inlineWorkerEnabled) {
      return;
    }

    this.logger.log(
      JSON.stringify({
        event: "inline_worker_started",
        worker_mode: this.config.workerMode,
        database: this.postgres.hasDatabase() ? "postgres" : "memory",
        redis: this.redis.hasRedis() ? "redis" : "memory"
      })
    );
    this.worker.startInBackground();
  }

  async onApplicationShutdown() {
    this.worker.stop();
    await this.worker.waitForStop();
  }
}
