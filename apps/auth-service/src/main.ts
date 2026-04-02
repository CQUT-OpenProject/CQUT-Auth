import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module.js";
import { ApiError } from "./common/api-error.js";
import { AppConfigService } from "./config/app-config.service.js";

process.env["WORKER_MODE"] ??=
  (process.env["APP_ENV"] ?? process.env["NODE_ENV"] ?? "development") === "production"
    ? "external"
    : "inline";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  const config = app.get(AppConfigService);
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.disable("x-powered-by");
  expressApp.set("trust proxy", config.trustProxyHops);
  expressApp.use(json({ limit: "16kb" }));
  expressApp.use(urlencoded({ extended: false, limit: "16kb", parameterLimit: 20 }));
  if (config.corsAllowedOrigins.length > 0) {
    app.enableCors({
      origin(
        origin: string | undefined,
        callback: (error: Error | null, allow?: boolean) => void
      ) {
        if (!origin || config.corsAllowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      }
    });
  }
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      stopAtFirstError: true,
      exceptionFactory(errors) {
        const firstError = errors[0];
        const firstConstraint = firstError ? Object.values(firstError.constraints ?? {})[0] : undefined;
        return new ApiError("invalid_request", typeof firstConstraint === "string" ? firstConstraint : "invalid request");
      }
    })
  );
  app.setGlobalPrefix("");
  await app.listen(config.port);
}

bootstrap();
