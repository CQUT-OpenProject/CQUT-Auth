import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import type { StaticConfig } from "../config.js";
import type { AuthenticatedPrincipal } from "../identity/index.js";
import type { InteractiveAuthenticatorService } from "../identity/index.js";
import { authenticateAgentRequest } from "../agent/agent-auth.js";
import type { PersistenceModules } from "../persistence/persistence.js";
import { RateLimitService } from "../persistence/rate-limit.service.js";
import { ManagementSessionService } from "../management/management-session.service.js";
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

type AgentRouterServices = {
  interactiveAuthenticator: InteractiveAuthenticatorService;
};

const agentOpenApiSpec = JSON.parse(
  readFileSync(resolve(process.cwd(), "openapi/agent.json"), "utf8"),
) as Record<string, unknown>;

const agentInstructionsTemplate = readFileSync(
  resolve(process.cwd(), "openapi/agent-instructions.md"),
  "utf8",
);

const agentInstructionsVersion = "1.0.0";

export function createAgentRouter(
  config: StaticConfig,
  services: AgentRouterServices,
  persistence: Pick<
    PersistenceModules,
    "identity" | "projects" | "clients" | "sessions"
  >,
  rateLimitService: RateLimitService,
  onClientsChanged: () => void,
): Router {
  const router = express.Router();
  const jsonParser = express.json({ limit: "64kb", strict: true });
  const { sessions, projects, clients, adminIds } =
    createManagementDomainServices(config, persistence);

  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/openapi.json", (_request, response) => {
    response.json(agentOpenApiSpec);
  });

  router.get("/instructions", (request, response) => {
    const baseUrl = agentBaseUrl(request);
    response.json({
      version: agentInstructionsVersion,
      baseUrl,
      openapiUrl: `${baseUrl}/openapi.json`,
      contentType: "text/markdown",
      prompt: agentInstructionsTemplate.replaceAll("{{baseUrl}}", baseUrl),
    });
  });

  router.post("/auth/login", jsonParser, async (request, response, next) => {
    try {
      await performInteractiveLogin(
        {
          config,
          rateLimitService,
          interactiveAuthenticator: services.interactiveAuthenticator,
          request,
          response,
          logLabel: "agent",
        },
        async (principal) => {
          const session = await sessions.create(principal.subjectId);
          response.json(
            agentLoginPayload(
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

  router.get("/auth/me", async (request, response, next) => {
    try {
      const auth = await requireAgentAuthentication(
        request,
        response,
        config,
        sessions,
        adminIds,
      );
      if (!auth) return;
      response.json(
        agentLoginPayload(
          config,
          auth.principal,
          auth.actor.isAdmin,
          auth.token,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/logout", async (request, response, next) => {
    try {
      const auth = await requireAgentAuthentication(
        request,
        response,
        config,
        sessions,
        adminIds,
      );
      if (!auth) return;
      await sessions.revoke(auth.token);
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
    withMutation: withActor,
  });

  router.use(jsonBodyErrorHandler);

  async function withActor(
    request: Request,
    response: Response,
    next: NextFunction,
    handler: (auth: ManagementAuth) => Promise<void>,
  ) {
    try {
      const auth = await requireAgentAuthentication(
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

  return router;
}

async function requireAgentAuthentication(
  request: Request,
  response: Response,
  config: StaticConfig,
  sessions: ManagementSessionService,
  adminIds: Set<string>,
): Promise<ManagementAuth | null> {
  const auth = await authenticateAgentRequest(
    request,
    config,
    sessions,
    adminIds,
  );
  if (!auth) {
    response.status(401).json({
      error: "login_required",
      error_description: "agent login is required",
    });
    return null;
  }
  return auth;
}

function agentBaseUrl(request: Request) {
  const forwardedProto = request.get("x-forwarded-proto");
  const protocol = forwardedProto?.split(",")[0]?.trim() ?? request.protocol;
  const host = request.get("host");
  return `${protocol}://${host}/api/agent`;
}

function agentLoginPayload(
  config: StaticConfig,
  principal: AuthenticatedPrincipal,
  isAdmin: boolean,
  token: string,
) {
  return {
    accessToken: token,
    tokenType: "Bearer",
    expiresIn: config.sessionTtlSeconds,
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
