import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import type { StaticConfig } from "../config.js";
import type {
  AuthenticatedPrincipal,
  InteractiveAuthenticatorService,
} from "../identity/index.js";
import { ClientManagementError } from "../management/management-error.js";
import type { PersistenceModules } from "../persistence/persistence.js";
import { RateLimitService } from "../persistence/rate-limit.service.js";
import { resolveTrustedExpressRequestIp } from "../request-ip.js";
import { ManagementSessionService } from "../management/management-session.service.js";
import type { RuntimePolicyModule } from "../runtime-policy.js";
import {
  clearManagementSessionCookie,
  clearManagementNonceCookie,
  rotateManagementNonceCookie,
  ensureManagementNonce,
  issueManagementCsrf,
  readManagementNonce,
  readManagementSessionToken,
  setManagementSessionCookie,
  validateManagementCsrf,
} from "../management/management-security.js";
import { registerManagementOperations } from "./management-operations.js";
import {
  handleInteractiveLoginOuterError,
  performInteractiveLogin,
} from "./management-login.js";
import { createManagementDomainServices } from "./management-services.js";
import {
  handleManagementError,
  jsonBodyErrorHandler,
  type ManagementAuth,
} from "./management-shared.js";

type ManagementRouterServices = {
  interactiveAuthenticator: InteractiveAuthenticatorService;
  runtimePolicy: RuntimePolicyModule;
};

export function createManagementRouter(
  config: StaticConfig,
  services: ManagementRouterServices,
  persistence: Pick<
    PersistenceModules,
    "identity" | "projects" | "clients" | "sessions" | "runtime"
  >,
  rateLimitService: RateLimitService,
  onClientsChanged: () => void,
  onRestartRequested?: () => void,
): Router {
  const router = express.Router();
  const jsonParser = express.json({ limit: "64kb", strict: true });
  const { sessions, projects, clients, adminIds } =
    createManagementDomainServices(config, persistence);
  const emailSettings = services.runtimePolicy;

  function requireAdmin(actor: { isAdmin: boolean }) {
    if (!actor.isAdmin) {
      throw new ClientManagementError(
        403,
        "access_denied",
        "administrator access is required",
      );
    }
  }

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
      await performInteractiveLogin(
        {
          config,
          rateLimitService,
          interactiveAuthenticator: services.interactiveAuthenticator,
          request,
          response,
          logLabel: "management",
        },
        async (principal) => {
          const session = await sessions.create(principal.subjectId);
          rotateManagementNonceCookie(response, config);
          setManagementSessionCookie(response, config, session.token);
          response.json(
            contextPayload(
              config,
              principal,
              adminIds.has(principal.subjectId),
              session.token,
            ),
          );
        },
      );
    } catch (error) {
      handleInteractiveLoginOuterError(error, response, next);
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
      clearManagementNonceCookie(response, config);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  registerManagementOperations({
    router,
    config,
    jsonParser,
    projects,
    clients,
    rateLimitService,
    onClientsChanged,
    withActor,
    withMutation,
    scope: {
      includeAuditLogs: true,
      includeClientSafety: true,
      includeSettings: true,
    },
    emailSettings,
    ...(onRestartRequested ? { onRestartRequested } : {}),
    requireAdmin,
  });

  router.use(jsonBodyErrorHandler);

  async function withActor(
    request: Request,
    response: Response,
    next: NextFunction,
    handler: (auth: ManagementAuth) => Promise<void>,
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
    handler: (auth: ManagementAuth) => Promise<void>,
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
  config: StaticConfig,
  sessions: ManagementSessionService,
  adminIds: Set<string>,
): Promise<ManagementAuth | null> {
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
  config: StaticConfig,
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
    clientSecretPolicy: {
      defaultGraceSeconds: config.clientSecretDefaultGraceSeconds,
      maxGraceSeconds: config.clientSecretMaxGraceSeconds,
    },
  };
}
