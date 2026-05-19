import express from "express";
import type { Request, Response, NextFunction } from "express";
import { readOidcOpConfig, type OidcOpConfig } from "./config.js";
import { createOidcServices } from "./oidc/provider.js";
import { RateLimitService, RateLimitUnavailableError } from "./persistence/rate-limit.service.js";
import type { OidcPersistence } from "./persistence/contracts.js";
import { OidcPersistenceImpl } from "./persistence/persistence.js";
import { createInteractionRouter } from "./routes/interactions.js";
import type { EmailSender } from "./email/email-sender.js";

type AppState = {
  config: OidcOpConfig;
  provider: any;
  store: OidcPersistence;
  rateLimitService: RateLimitService;
  closeOidcServices(): Promise<void>;
};

type AppDependencies = {
  emailSender?: EmailSender;
};

function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction) {
  console.error("[oidc-op] unhandled application error", error);
  response
    .status(500)
    .setHeader("Cache-Control", "no-store")
    .json({
      error: "server_error",
      error_description: "internal server error"
    });
}

export async function createOidcApp(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AppDependencies = {}
) {
  const config = readOidcOpConfig(env);
  const store = new OidcPersistenceImpl(config);
  await store.init();
  const rateLimitService = new RateLimitService(config);
  await rateLimitService.init();
  const services = await createOidcServices(
    config,
    store,
    rateLimitService,
    dependencies.emailSender
  );

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops);

  app.get("/health/live", (_request, response) => {
    response.json({ status: "live" });
  });

  app.get("/health/ready", async (_request, response) => {
    const databaseReady = await store.checkReadiness();
    const redisReady = await rateLimitService.checkReadiness();
    response.status(databaseReady && redisReady ? 200 : 503).json({
      status: databaseReady && redisReady ? "ready" : "degraded",
      issuer: config.issuer,
      database: store.hasDatabase() ? "postgres" : "memory",
      redis: config.redisUrl ? (redisReady ? "ready" : "unavailable") : "optional"
    });
  });

  app.use((request, response, next) => {
    if (request.path === "/session/end" || request.path.startsWith("/session/end/")) {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      );
      response.setHeader("X-Frame-Options", "DENY");
    }
    next();
  });

  app.use("/interaction", createInteractionRouter(config, services.provider, services, store, rateLimitService));
  app.use((request, response, next) => {
    if (request.path === "/session/end") {
      response.clearCookie("op_csrf", {
        path: "/",
        sameSite: "lax",
        secure: config.cookieSecure
      });
      response.clearCookie("op_csrf_nonce", {
        path: "/",
        sameSite: "lax",
        secure: config.cookieSecure
      });
    }
    next();
  });
  app.use(services.provider.callback());
  app.use(errorHandler);

  const state: AppState = {
    config,
    provider: services.provider,
    store,
    rateLimitService,
    closeOidcServices: services.close
  };
  return { app, state } as { app: express.Express; state: AppState };
}
