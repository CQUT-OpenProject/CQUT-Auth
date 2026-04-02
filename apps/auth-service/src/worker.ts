import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { VerificationWorkerService } from "./worker/verification-worker.service.js";

process.env["WORKER_MODE"] = "external";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"]
  });
  const worker = app.get(VerificationWorkerService);

  const shutdown = async () => {
    worker.stop();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await worker.start();
}

void bootstrap();
