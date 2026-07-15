import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { readOidcOpConfig, type OidcOpConfig } from "./config.js";
import { createOidcServices } from "./oidc/provider.js";
import { RateLimitService } from "./persistence/rate-limit.service.js";
import type { OidcPersistence } from "./persistence/contracts.js";
import { OidcPersistenceImpl } from "./persistence/persistence.js";
import { createInteractionRouter } from "./routes/interactions.js";
import { createManagementRouter } from "./routes/management.js";
import type { EmailSender } from "./email/email-sender.js";
import { withAuthorizationContext } from "./oidc/authorization-context.js";

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

function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
) {
  console.error("[oidc-op] unhandled application error", error);
  response.status(500).setHeader("Cache-Control", "no-store").json({
    error: "server_error",
    error_description: "internal server error",
  });
}

function cspSourceForOrigin(origin: string): string | undefined {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function buildFormActionSources(config: OidcOpConfig, redirectUris: string[]) {
  const sources = new Set<string>(["'self'"]);
  for (const uri of redirectUris) {
    const source = cspSourceForOrigin(uri);
    if (source) {
      sources.add(source);
    }
  }
  const issuerSource = cspSourceForOrigin(config.issuer);
  if (issuerSource) {
    sources.add(issuerSource);
  }
  return [...sources];
}

function applySecurityHeaders(getFormActionSources: () => Promise<string[]>) {
  return async (_request: Request, response: Response, next: NextFunction) => {
    let formActionSources: string[];
    try {
      formActionSources = await getFormActionSources();
    } catch (error) {
      next(error);
      return;
    }
    const scriptNonce = randomBytes(16).toString("base64");
    response.locals["cspScriptNonce"] = scriptNonce;
    response.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        `form-action ${formActionSources.join(" ")}`,
        "style-src 'self' 'unsafe-inline'",
        `script-src 'nonce-${scriptNonce}' 'self'`,
        "connect-src 'self'",
        "img-src 'self' data:",
      ].join("; "),
    );
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  };
}

export async function createOidcApp(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AppDependencies = {},
) {
  const config = readOidcOpConfig(env);
  if (config.adminSubjectIds.length === 0) {
    console.warn(
      "[oidc-op] OIDC_ADMIN_SUBJECT_IDS is empty; client approvals are unavailable",
    );
  }
  const store = new OidcPersistenceImpl(config);
  await store.init();
  const rateLimitService = new RateLimitService(config);
  await rateLimitService.init();
  const services = await createOidcServices(
    config,
    store,
    rateLimitService,
    dependencies.emailSender,
  );

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops);
  let formActionSources = buildFormActionSources(config, []);
  let formActionSourcesExpiresAt = 0;
  const invalidateClientOrigins = () => {
    formActionSourcesExpiresAt = 0;
  };
  const getFormActionSources = async () => {
    if (Date.now() >= formActionSourcesExpiresAt) {
      const clients = await store.listActiveOidcClients();
      formActionSources = buildFormActionSources(
        config,
        clients.flatMap((client) => client.redirectUris),
      );
      formActionSourcesExpiresAt = Date.now() + 5_000;
    }
    return formActionSources;
  };
  app.get("/health/live", (_request, response) => {
    response.json({ status: "live" });
  });

  app.use(applySecurityHeaders(getFormActionSources));
  app.use(withAuthorizationContext);

  app.get("/health/ready", async (_request, response) => {
    const databaseReady = await store.checkReadiness();
    const redisReady = await rateLimitService.checkReadiness();
    response.status(databaseReady && redisReady ? 200 : 503).json({
      status: databaseReady && redisReady ? "ready" : "degraded",
      issuer: config.issuer,
      database: store.hasDatabase() ? "postgres" : "memory",
      redis: config.redisUrl
        ? redisReady
          ? "ready"
          : "unavailable"
        : "optional",
    });
  });

  app.use(
    "/api/management",
    createManagementRouter(
      config,
      services,
      store,
      rateLimitService,
      invalidateClientOrigins,
    ),
  );
  const managementAssets = resolve(process.cwd(), "dist/management");
  app.get("/favicon.svg", (_request, response) => {
    response.sendFile(resolve(managementAssets, "favicon.svg"));
  });
  app.get("/manage/favicon.svg", (_request, response) => {
    response.sendFile(resolve(managementAssets, "favicon.svg"));
  });
  app.use(
    "/manage/assets",
    express.static(resolve(managementAssets, "assets"), {
      immutable: true,
      maxAge: "1y",
    }),
  );
  app.get(/^\/manage(?:\/.*)?$/, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(resolve(managementAssets, "index.html"));
  });

  app.use(
    "/interaction",
    createInteractionRouter(
      config,
      services.provider,
      services,
      store,
      rateLimitService,
    ),
  );
  app.use((request, response, next) => {
    if (request.path === "/session/end") {
      response.clearCookie("op_csrf", {
        path: "/",
        sameSite: "lax",
        secure: config.cookieSecure,
      });
      response.clearCookie("op_csrf_nonce", {
        path: "/",
        sameSite: "lax",
        secure: config.cookieSecure,
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
    closeOidcServices: services.close,
  };
  return { app, state } as { app: express.Express; state: AppState };
}
