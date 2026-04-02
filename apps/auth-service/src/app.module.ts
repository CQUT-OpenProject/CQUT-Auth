import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AppConfigurationModule } from "./config/config.module.js";
import { PersistenceModule } from "./persistence/persistence.module.js";
import { ProvidersModule } from "./providers/providers.module.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { DedupeKeyService } from "./auth/dedupe-key.service.js";
import { VerifyRateLimitService } from "./auth/verify-rate-limit.service.js";
import { ClientService } from "./clients/client.service.js";
import { RateLimitFilter } from "./common/rate-limit.filter.js";
import { JobPayloadCryptoService } from "./common/job-payload-crypto.service.js";
import { MetricsService } from "./common/metrics.service.js";
import { HealthController } from "./health/health.controller.js";
import { InlineWorkerLifecycle } from "./worker/inline-worker.lifecycle.js";
import { VerificationWorkerService } from "./worker/verification-worker.service.js";

@Module({
  imports: [AppConfigurationModule, PersistenceModule, ProvidersModule],
  controllers: [AuthController, HealthController],
  providers: [
    AuthService,
    DedupeKeyService,
    VerifyRateLimitService,
    ClientService,
    JobPayloadCryptoService,
    MetricsService,
    InlineWorkerLifecycle,
    VerificationWorkerService,
    {
      provide: APP_FILTER,
      useClass: RateLimitFilter
    }
  ]
})
export class AppModule {}
