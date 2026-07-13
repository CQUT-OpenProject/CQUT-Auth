import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import type { OidcOpConfig } from "../config.js";
import type {
  AuthenticatedPrincipal,
  InteractiveAuthenticatorService,
} from "../identity/index.js";
import {
  ClientManagementError,
  ClientManagementService,
} from "../clients/client-management.service.js";
import type { OidcPersistence } from "../persistence/contracts.js";
import {
  RateLimitService,
  RateLimitUnavailableError,
} from "../persistence/rate-limit.service.js";
import { resolveTrustedExpressRequestIp } from "../request-ip.js";
import { sha256 } from "../utils.js";
import { ManagementSessionService } from "../management/management-session.service.js";
import {
  clearManagementSessionCookie,
  ensureManagementNonce,
  issueManagementCsrf,
  readManagementNonce,
  readManagementSessionToken,
  setManagementSessionCookie,
  validateManagementCsrf,
} from "../management/management-security.js";

type ManagementRouterServices = {
  interactiveAuthenticator: InteractiveAuthenticatorService;
};

export function createManagementRouter(
  config: OidcOpConfig,
  services: ManagementRouterServices,
  store: OidcPersistence,
  rateLimitService: RateLimitService,
  onClientsChanged: () => void,
): Router {
  const router = express.Router();
  const jsonParser = express.json({ limit: "64kb", strict: true });
  const sessions = new ManagementSessionService(
    store,
    config.sessionTtlSeconds,
    config.sessionIdleTtlSeconds,
  );
  const clients = new ClientManagementService(store, config.appEnv, {
    maxClientsPerOwner: config.managementClientMaxPerSubject,
    maxPendingClientsPerOwner: config.managementClientMaxPendingPerSubject,
    adminQuotaExempt: config.managementClientQuotaAdminExempt,
  });
  const adminIds = new Set(config.adminSubjectIds);

  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/auth/context", async (request, response, next) => {
    try {
      const token = readManagementSessionToken(request, config);
      const principal = await sessions.authenticate(token);
      if (!principal || !token) {
        const nonce = ensureManagementNonce(request, response, config);
        response.json({
          authenticated: false,
          csrfToken: issueManagementCsrf(config, nonce),
        });
        return;
      }
      response.json(
        contextPayload(
          config,
          principal,
          adminIds.has(principal.subjectId),
          token,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/login", jsonParser, async (request, response, next) => {
    try {
      const nonce = readManagementNonce(request, config);
      if (!nonce || !validateManagementCsrf(request, config, nonce)) {
        response.status(400).json({
          error: "invalid_request",
          error_description: "CSRF validation failed",
        });
        return;
      }
      const account =
        typeof request.body?.account === "string"
          ? request.body.account.trim()
          : "";
      const password =
        typeof request.body?.password === "string" ? request.body.password : "";
      const ip = resolveTrustedExpressRequestIp(config, request);
      const attemptKey = `oidc:login:attempt:account-ip:${sha256(account || "unknown")}:${ip}`;
      const attempt = await rateLimitService.consume(
        attemptKey,
        config.loginRateLimitMax,
        config.loginRateLimitWindowSeconds,
      );
      if (!attempt.allowed) {
        response.setHeader("Retry-After", String(attempt.retryAfterSeconds));
        response.status(429).json({
          error: "rate_limited",
          error_description: "login attempts exceeded",
        });
        return;
      }
      try {
        const principal = await services.interactiveAuthenticator.authenticate({
          provider: config.authProvider,
          account,
          password,
          ip,
          ...(request.get("user-agent")
            ? { userAgent: request.get("user-agent") as string }
            : {}),
        });
        await rateLimitService.reset(attemptKey).catch(() => undefined);
        const session = await sessions.create(principal.subjectId);
        setManagementSessionCookie(response, config, session.token);
        response.json(
          contextPayload(
            config,
            principal,
            adminIds.has(principal.subjectId),
            session.token,
          ),
        );
      } catch (error) {
        const failureKey = `oidc:login:failure:account-ip:${sha256(account || "unknown")}:${ip}`;
        const failure = await rateLimitService.consume(
          failureKey,
          config.loginFailureLimit,
          config.loginFailureWindowSeconds,
        );
        if (!failure.allowed) {
          response.setHeader("Retry-After", String(failure.retryAfterSeconds));
          response.status(429).json({
            error: "rate_limited",
            error_description: "login failures exceeded",
          });
          return;
        }
        console.error(
          "[oidc-op] management sign-in failed",
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : "unknown error",
        );
        response.status(401).json({
          error: "access_denied",
          error_description: "invalid account or password",
        });
      }
    } catch (error) {
      if (error instanceof RateLimitUnavailableError) {
        response.setHeader("Retry-After", "60");
        response.status(503).json({
          error: "service_unavailable",
          error_description: "try again later",
        });
        return;
      }
      next(error);
    }
  });

  router.post("/auth/logout", async (request, response, next) => {
    try {
      const auth = await requireAuthentication(
        request,
        response,
        config,
        sessions,
        adminIds,
      );
      if (!auth) return;
      if (!validateManagementCsrf(request, config, auth.token)) {
        response.status(400).json({
          error: "invalid_request",
          error_description: "CSRF validation failed",
        });
        return;
      }
      await sessions.revoke(auth.token);
      clearManagementSessionCookie(response, config);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/clients", async (request, response, next) => {
    await withActor(request, response, next, async (auth) => {
      const viewAll = request.query["view"] === "all";
      response.json({ clients: await clients.list(auth.actor, viewAll) });
    });
  });

  router.post("/clients", jsonParser, async (request, response, next) => {
    await withMutation(request, response, next, async (auth) => {
      const limits = [
        {
          key: `oidc:management:client-create:subject:${sha256(auth.actor.subjectId)}`,
          max: config.managementClientCreateRateLimitSubjectMax,
        },
        {
          key: `oidc:management:client-create:ip:${auth.actor.sourceIp ?? "unknown"}`,
          max: config.managementClientCreateRateLimitIpMax,
        },
      ];
      for (const limit of limits) {
        const decision = await rateLimitService.consume(
          limit.key,
          limit.max,
          config.managementClientCreateRateLimitWindowSeconds,
        );
        if (!decision.allowed) {
          response.setHeader("Retry-After", String(decision.retryAfterSeconds));
          response.status(429).json({
            error: "rate_limited",
            error_description: "client creation rate limit exceeded",
          });
          return;
        }
      }
      const result = await clients.create(auth.actor, request.body);
      onClientsChanged();
      response.status(201).json(result);
    });
  });

  router.post(
    "/clients/:clientId/submit",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        const client = await clients.submit(
          auth.actor,
          param(request, "clientId"),
          request.body,
        );
        response.json({ client });
      });
    },
  );

  router.get("/clients/:clientId", async (request, response, next) => {
    await withActor(request, response, next, async (auth) => {
      response.json({
        client: await clients.get(auth.actor, param(request, "clientId")),
      });
    });
  });

  router.patch(
    "/clients/:clientId",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        const client = await clients.update(
          auth.actor,
          param(request, "clientId"),
          request.body,
        );
        onClientsChanged();
        response.json({ client });
      });
    },
  );

  router.post(
    "/clients/:clientId/disable",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        const client = await clients.disable(
          auth.actor,
          param(request, "clientId"),
          request.body,
        );
        onClientsChanged();
        response.json({ client });
      });
    },
  );

  router.get("/admin/reviews", async (request, response, next) => {
    await withActor(request, response, next, async (auth) => {
      response.json({ clients: await clients.listPending(auth.actor) });
    });
  });

  router.post(
    "/admin/reviews/:clientId/approve",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        const client = await clients.approve(
          auth.actor,
          param(request, "clientId"),
          request.body,
        );
        onClientsChanged();
        response.json({ client });
      });
    },
  );

  router.post(
    "/admin/reviews/:clientId/reject",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        const client = await clients.reject(
          auth.actor,
          param(request, "clientId"),
          request.body,
        );
        onClientsChanged();
        response.json({ client });
      });
    },
  );

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      const status = (error as { status?: unknown }).status;
      if (status === 400) {
        response.status(400).json({
          error: "invalid_request",
          error_description: "invalid JSON request body",
        });
        return;
      }
      handleManagementError(error, response, next);
    },
  );

  async function withActor(
    request: Request,
    response: Response,
    next: NextFunction,
    handler: (
      auth: Awaited<ReturnType<typeof requireAuthentication>> & {},
    ) => Promise<void>,
  ) {
    try {
      const auth = await requireAuthentication(
        request,
        response,
        config,
        sessions,
        adminIds,
      );
      if (!auth) return;
      await handler(auth);
    } catch (error) {
      handleManagementError(error, response, next);
    }
  }

  async function withMutation(
    request: Request,
    response: Response,
    next: NextFunction,
    handler: (
      auth: Awaited<ReturnType<typeof requireAuthentication>> & {},
    ) => Promise<void>,
  ) {
    await withActor(request, response, next, async (auth) => {
      if (!validateManagementCsrf(request, config, auth.token)) {
        response.status(400).json({
          error: "invalid_request",
          error_description: "CSRF validation failed",
        });
        return;
      }
      await handler(auth);
    });
  }

  return router;
}

async function requireAuthentication(
  request: Request,
  response: Response,
  config: OidcOpConfig,
  sessions: ManagementSessionService,
  adminIds: Set<string>,
) {
  const token = readManagementSessionToken(request, config);
  const principal = await sessions.authenticate(token);
  if (!principal || !token) {
    response.status(401).json({
      error: "login_required",
      error_description: "management login is required",
    });
    return null;
  }
  return {
    token,
    principal,
    actor: {
      subjectId: principal.subjectId,
      isAdmin: adminIds.has(principal.subjectId),
      sourceIp: resolveTrustedExpressRequestIp(config, request),
    },
  };
}

function contextPayload(
  config: OidcOpConfig,
  principal: AuthenticatedPrincipal,
  isAdmin: boolean,
  token: string,
) {
  return {
    authenticated: true,
    csrfToken: issueManagementCsrf(config, token),
    user: {
      subjectId: principal.subjectId,
      preferredUsername: principal.preferredUsername,
      displayName: principal.displayName ?? principal.preferredUsername,
      isAdmin,
    },
  };
}

function handleManagementError(
  error: unknown,
  response: Response,
  next: NextFunction,
) {
  if (error instanceof ClientManagementError) {
    response.status(error.status).json({
      error: error.code,
      error_description: error.message,
      ...(error.field
        ? { field_errors: { [error.field]: error.message } }
        : {}),
    });
    return;
  }
  if (error instanceof RateLimitUnavailableError) {
    response.setHeader("Retry-After", "60");
    response.status(503).json({
      error: "service_unavailable",
      error_description: "try again later",
    });
    return;
  }
  next(error);
}

function param(request: Request, name: string) {
  const value = request.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
