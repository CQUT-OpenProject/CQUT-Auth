import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { readConfig, type StaticConfig } from "./config.js";
import { defaultRuntimePolicy, RuntimePolicyModule } from "./runtime-policy.js";
import type { PolicyValues } from "./runtime-policy.js";
import { createOidcRuntime } from "./oidc/provider.js";
import { RateLimitService } from "./persistence/rate-limit.service.js";
import {
  createPersistence,
  type PersistenceModules,
} from "./persistence/persistence.js";
import { createInteractionRouter } from "./routes/interactions.js";
import { createManagementRouter } from "./routes/management.js";
import type { EmailSender } from "./email/email-sender.js";
import { withAuthorizationContext } from "./oidc/authorization-context.js";

type AppState = {
  config: StaticConfig;
  persistence: PersistenceModules;
  rateLimitService: RateLimitService;
  close(): Promise<void>;
};

type AppDependencies = {
  emailSender?: EmailSender;
  runtimePolicyOverrides?: Partial<PolicyValues>;
  requestRestart?: () => void;
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

function buildFormActionSources(config: StaticConfig, redirectUris: string[]) {
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
  const staticConfig = readConfig(env);
  if (staticConfig.adminSubjectIds.length === 0) {
    console.warn(
      "[oidc-op] OIDC_ADMIN_SUBJECT_IDS is empty; client approvals are unavailable",
    );
  }
  const persistence = await createPersistence(staticConfig);
  const policyDefaults = defaultRuntimePolicy(staticConfig);
  Object.assign(policyDefaults.policy, dependencies.runtimePolicyOverrides);
  const runtimePolicy = new RuntimePolicyModule(
    persistence.settings,
    staticConfig.keyEncryptionSecret,
    policyDefaults,
  );
  const policySnapshot = await runtimePolicy.initialize();
  const config: StaticConfig = Object.freeze({
    ...staticConfig,
    ...policySnapshot.policy,
  });
  const rateLimitService = new RateLimitService(config);
  await rateLimitService.init();
  const services = await createOidcRuntime(
    config,
    persistence,
    rateLimitService,
    dependencies.emailSender,
    runtimePolicy,
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
      const clients = await persistence.clients.listActiveOidcClients();
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
    const databaseReady = await persistence.runtime.checkReadiness();
    const redisReady = await rateLimitService.checkReadiness();
    const emailReady =
      !config.emailVerificationEnabled || runtimePolicy.isEmailConfigured();
    response
      .status(databaseReady && redisReady && emailReady ? 200 : 503)
      .json({
        status:
          databaseReady && redisReady && emailReady ? "ready" : "degraded",
        issuer: config.issuer,
        database: persistence.runtime.hasDatabase() ? "postgres" : "memory",
        redis: config.redisUrl
          ? redisReady
            ? "ready"
            : "unavailable"
          : "optional",
        email: emailReady ? "ready" : "unconfigured",
      });
  });

  app.use(
    "/api/management",
    createManagementRouter(
      config,
      services,
      persistence,
      rateLimitService,
      invalidateClientOrigins,
      dependencies.requestRestart,
    ),
  );
  const managementAssets = resolve(process.cwd(), "dist/management");
  app.get("/favicon.svg", (_request, response) => {
    response.sendFile(resolve(managementAssets, "favicon.svg"));
  });
  app.get("/manage/favicon.svg", (_request, response) => {
    response.sendFile(resolve(managementAssets, "favicon.svg"));
  });
  app.get("/logo-auth-color.svg", (_request, response) => {
    response.sendFile(resolve(managementAssets, "logo-auth-color.svg"));
  });
  app.get("/logo-auth-mono-light.svg", (_request, response) => {
    response.sendFile(resolve(managementAssets, "logo-auth-mono-light.svg"));
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
      services.interactions,
      services,
      persistence,
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
  app.use(services.middleware);
  app.use(errorHandler);

  const state: AppState = {
    config,
    persistence,
    rateLimitService,
    async close() {
      await services.close();
      await rateLimitService.close();
      await persistence.runtime.close();
    },
  };
  return { app, state } as { app: express.Express; state: AppState };
}
