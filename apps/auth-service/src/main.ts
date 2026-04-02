import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { AppConfigService } from "./config/app-config.service.js";

process.env["WORKER_MODE"] ??=
  (process.env["APP_ENV"] ?? process.env["NODE_ENV"] ?? "development") === "production"
    ? "external"
    : "inline";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      stopAtFirstError: true
    })
  );
  app.setGlobalPrefix("");
  const config = app.get(AppConfigService);
  await app.listen(config.port);
}

bootstrap();
