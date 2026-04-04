import express from "express";
import type { Request, Response, NextFunction } from "express";
import { readOidcOpConfig, type OidcOpConfig } from "./config.js";
import { createOidcServices } from "./oidc/provider.js";
import { RateLimitService } from "./persistence/rate-limit.service.js";
import { OidcStore } from "./persistence/store.js";
import { createInteractionRouter } from "./routes/interactions.js";
import { parseCookies } from "./utils.js";

type AppState = {
  config: OidcOpConfig;
  provider: any;
  store: OidcStore;
  rateLimitService: RateLimitService;
};

function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction) {
  response
    .status(500)
    .setHeader("Cache-Control", "no-store")
    .json({
      error: "server_error",
      error_description: error instanceof Error ? error.message : "unknown error"
    });
}

function tokenRateLimitMiddleware(config: OidcOpConfig, rateLimitService: RateLimitService) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const authorization = request.get("authorization");
    let clientId = "public";
    if (authorization?.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator > 0) {
          clientId = decoded.slice(0, separator);
        }
      } catch {
        clientId = "public";
      }
    }
    const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
    const decision = await rateLimitService.consume(
      `oidc:token:${clientId}:${ip}`,
      config.tokenRateLimitMax,
      config.tokenRateLimitWindowSeconds
    );
    if (!decision.allowed) {
      response
        .status(429)
        .setHeader("Retry-After", String(decision.retryAfterSeconds))
        .setHeader("Cache-Control", "no-store")
        .json({
          error: "rate_limited",
          error_description: "token endpoint rate limit exceeded",
          retry_after_seconds: decision.retryAfterSeconds
        });
      return;
    }
    next();
  };
}

export async function createOidcApp(env: NodeJS.ProcessEnv = process.env) {
  const config = readOidcOpConfig(env);
  const store = new OidcStore(config);
  await store.init();
  const rateLimitService = new RateLimitService(config);
  await rateLimitService.init();
  const services = await createOidcServices(config, store);

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

  app.use("/interaction", createInteractionRouter(config, services.provider, services, store, rateLimitService));
  app.use("/token", tokenRateLimitMiddleware(config, rateLimitService));
  app.use((request, response, next) => {
    const cookies = parseCookies(request.headers.cookie);
    if (cookies["op_csrf"] && request.path === "/session/end") {
      response.clearCookie("op_csrf", {
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
    rateLimitService
  };
  return { app, state } as { app: express.Express; state: AppState };
}
