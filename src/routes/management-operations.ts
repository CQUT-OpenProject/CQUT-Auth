import type { RequestHandler, Router } from "express";
import type { StaticConfig } from "../config.js";
import { ClientManagementService } from "../clients/client-management.service.js";
import { ClientManagementError } from "../management/management-error.js";
import { ProjectManagementService } from "../projects/project-management.service.js";
import {
  RateLimitService,
  RateLimitUnavailableError,
  resetRateLimitKeys,
} from "../persistence/rate-limit.service.js";
import type { RuntimePolicyModule } from "../runtime-policy.js";
import { sha256 } from "../utils.js";
import { enforceRateLimits } from "./management-rate-limit.js";
import {
  routeParam,
  type ManagementRouteGuard,
  writeRateLimited,
} from "./management-shared.js";

export type ManagementOperationsScope = {
  includeAuditLogs?: boolean;
  includeClientSafety?: boolean;
  includeSettings?: boolean;
};

export type ManagementOperationsDeps = {
  router: Router;
  config: StaticConfig;
  jsonParser: RequestHandler;
  projects: ProjectManagementService;
  clients: ClientManagementService;
  rateLimitService: RateLimitService;
  onClientsChanged: () => void;
  withActor: ManagementRouteGuard;
  withMutation: ManagementRouteGuard;
  scope?: ManagementOperationsScope;
  emailSettings?: RuntimePolicyModule;
  onRestartRequested?: () => void;
  requireAdmin?: (actor: { isAdmin: boolean }) => void;
};

export function registerManagementOperations(deps: ManagementOperationsDeps) {
  const {
    router,
    config,
    jsonParser,
    projects,
    clients,
    rateLimitService,
    onClientsChanged,
    withActor,
    withMutation,
    emailSettings,
    onRestartRequested,
    requireAdmin,
  } = deps;
  const scope = {
    includeAuditLogs: false,
    includeClientSafety: false,
    includeSettings: false,
    ...deps.scope,
  };

  router.get("/projects", async (request, response, next) => {
    await withActor(request, response, next, async (auth) => {
      response.json({ projects: await projects.list(auth.actor) });
    });
  });

  router.post("/projects", jsonParser, async (request, response, next) => {
    await withMutation(request, response, next, async (auth) => {
      if (!(auth.actor.isAdmin && config.managementProjectQuotaAdminExempt)) {
        const { decision, consumedKeys } = await enforceRateLimits(
          rateLimitService,
          [
            {
              key: `oidc:management:project-create:subject:${sha256(auth.actor.subjectId)}`,
              max: config.managementProjectCreateRateLimitSubjectMax,
            },
            {
              key: `oidc:management:project-create:ip:${auth.actor.sourceIp ?? "unknown"}`,
              max: config.managementProjectCreateRateLimitIpMax,
            },
          ],
          config.managementProjectCreateRateLimitWindowSeconds,
        );
        if (decision) {
          writeRateLimited(
            response,
            decision,
            "project creation rate limit exceeded",
          );
          return;
        }
        try {
          response
            .status(201)
            .json({ project: await projects.create(auth.actor, request.body) });
        } catch (error) {
          await resetRateLimitKeys(rateLimitService, consumedKeys).catch(
            (resetError) => {
              if (!(resetError instanceof RateLimitUnavailableError)) {
                throw resetError;
              }
            },
          );
          throw error;
        }
        return;
      }
      response
        .status(201)
        .json({ project: await projects.create(auth.actor, request.body) });
    });
  });

  router.get("/projects/:projectId", async (request, response, next) => {
    await withActor(request, response, next, async (auth) => {
      response.json({
        project: await projects.get(
          auth.actor,
          routeParam(request, "projectId"),
        ),
      });
    });
  });

  router.patch(
    "/projects/:projectId",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        response.json({
          project: await projects.update(
            auth.actor,
            routeParam(request, "projectId"),
            request.body,
          ),
        });
      });
    },
  );

  router.get(
    "/projects/:projectId/members",
    async (request, response, next) => {
      await withActor(request, response, next, async (auth) => {
        response.json({
          members: await projects.members(
            auth.actor,
            routeParam(request, "projectId"),
          ),
        });
      });
    },
  );

  router.post(
    "/projects/:projectId/members",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        response.status(201).json({
          project: await projects.addMember(
            auth.actor,
            routeParam(request, "projectId"),
            request.body,
          ),
        });
      });
    },
  );

  router.patch(
    "/projects/:projectId/members/:subjectId",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        response.json({
          project: await projects.updateMember(
            auth.actor,
            routeParam(request, "projectId"),
            routeParam(request, "subjectId"),
            request.body,
          ),
        });
      });
    },
  );

  router.delete(
    "/projects/:projectId/members/:subjectId",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        response.json({
          project: await projects.removeMember(
            auth.actor,
            routeParam(request, "projectId"),
            routeParam(request, "subjectId"),
            request.body,
          ),
        });
      });
    },
  );

  router.post(
    "/projects/:projectId/ownership/transfer",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        response.json({
          project: await projects.transfer(
            auth.actor,
            routeParam(request, "projectId"),
            request.body,
          ),
        });
      });
    },
  );

  if (scope.includeAuditLogs) {
    router.get(
      "/projects/:projectId/audit-logs",
      async (request, response, next) => {
        await withActor(request, response, next, async (auth) => {
          const limit = Math.min(
            100,
            Math.max(1, Number(request.query["limit"] ?? 50) || 50),
          );
          const rawBeforeId = request.query["beforeId"];
          const beforeId =
            rawBeforeId === undefined ? undefined : Number(rawBeforeId);
          if (
            beforeId !== undefined &&
            (!Number.isInteger(beforeId) || beforeId <= 0)
          ) {
            throw new ClientManagementError(
              400,
              "invalid_request",
              "beforeId must be a positive integer",
            );
          }
          response.json({
            auditLogs: await projects.audits(
              auth.actor,
              routeParam(request, "projectId"),
              limit,
              beforeId,
            ),
          });
        });
      },
    );
  }

  router.get(
    "/projects/:projectId/clients",
    async (request, response, next) => {
      await withActor(request, response, next, async (auth) => {
        response.json({
          clients: await clients.list(
            auth.actor,
            routeParam(request, "projectId"),
          ),
        });
      });
    },
  );

  router.post(
    "/projects/:projectId/clients",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        const { decision, consumedKeys } = await enforceRateLimits(
          rateLimitService,
          [
            {
              key: `oidc:management:client-create:subject:${sha256(auth.actor.subjectId)}`,
              max: config.managementClientCreateRateLimitSubjectMax,
            },
            {
              key: `oidc:management:client-create:ip:${auth.actor.sourceIp ?? "unknown"}`,
              max: config.managementClientCreateRateLimitIpMax,
            },
          ],
          config.managementClientCreateRateLimitWindowSeconds,
        );
        if (decision) {
          writeRateLimited(
            response,
            decision,
            "client creation rate limit exceeded",
          );
          return;
        }
        try {
          const result = await clients.create(
            auth.actor,
            routeParam(request, "projectId"),
            request.body,
          );
          onClientsChanged();
          response.status(201).json(result);
        } catch (error) {
          await resetRateLimitKeys(rateLimitService, consumedKeys).catch(
            (resetError) => {
              if (!(resetError instanceof RateLimitUnavailableError)) {
                throw resetError;
              }
            },
          );
          throw error;
        }
      });
    },
  );

  router.get(
    "/projects/:projectId/clients/:clientId",
    async (request, response, next) => {
      await withActor(request, response, next, async (auth) => {
        response.json({
          client: await clients.get(
            auth.actor,
            routeParam(request, "projectId"),
            routeParam(request, "clientId"),
          ),
        });
      });
    },
  );

  router.put(
    "/projects/:projectId/clients/:clientId/revision",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        const client = await clients.saveRevision(
          auth.actor,
          routeParam(request, "projectId"),
          routeParam(request, "clientId"),
          request.body,
        );
        onClientsChanged();
        response.json({ client });
      });
    },
  );

  router.patch(
    "/projects/:projectId/clients/:clientId",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        const client = await clients.update(
          auth.actor,
          routeParam(request, "projectId"),
          routeParam(request, "clientId"),
          request.body,
        );
        response.json({ client });
      });
    },
  );

  router.post(
    "/projects/:projectId/clients/:clientId/secrets/rotate",
    jsonParser,
    async (request, response, next) => {
      await withMutation(request, response, next, async (auth) => {
        const clientId = routeParam(request, "clientId");
        const { decision, consumedKeys } = await enforceRateLimits(
          rateLimitService,
          [
            {
              key: `oidc:management:secret-rotate:subject:${sha256(auth.actor.subjectId)}`,
              max: config.clientSecretRotateRateLimitSubjectMax,
            },
            {
              key: `oidc:management:secret-rotate:client:${sha256(clientId)}`,
              max: config.clientSecretRotateRateLimitClientMax,
            },
            {
              key: `oidc:management:secret-rotate:ip:${auth.actor.sourceIp ?? "unknown"}`,
              max: config.clientSecretRotateRateLimitIpMax,
            },
          ],
          config.clientSecretRotateRateLimitWindowSeconds,
        );
        if (decision) {
          writeRateLimited(
            response,
            decision,
            "secret rotation rate limit exceeded",
          );
          return;
        }
        try {
          const result = await clients.rotateSecret(
            auth.actor,
            routeParam(request, "projectId"),
            clientId,
            request.body,
          );
          response.status(201).json(result);
        } catch (error) {
          await resetRateLimitKeys(rateLimitService, consumedKeys).catch(
            (resetError) => {
              if (!(resetError instanceof RateLimitUnavailableError)) {
                throw resetError;
              }
            },
          );
          throw error;
        }
      });
    },
  );

  if (scope.includeClientSafety) {
    router.post(
      "/projects/:projectId/clients/:clientId/secrets/:secretId/revoke",
      jsonParser,
      async (request, response, next) => {
        await withMutation(request, response, next, async (auth) => {
          const client = await clients.revokeSecret(
            auth.actor,
            routeParam(request, "projectId"),
            routeParam(request, "clientId"),
            routeParam(request, "secretId"),
            request.body,
          );
          response.json({ client });
        });
      },
    );

    router.post(
      "/projects/:projectId/clients/:clientId/authorizations/revoke",
      jsonParser,
      async (request, response, next) => {
        await withMutation(request, response, next, async (auth) => {
          const client = await clients.revokeAuthorizations(
            auth.actor,
            routeParam(request, "projectId"),
            routeParam(request, "clientId"),
            request.body,
          );
          response.json({ client });
        });
      },
    );

    router.post(
      "/projects/:projectId/clients/:clientId/disable",
      jsonParser,
      async (request, response, next) => {
        await withMutation(request, response, next, async (auth) => {
          const client = await clients.disable(
            auth.actor,
            routeParam(request, "projectId"),
            routeParam(request, "clientId"),
            request.body,
          );
          onClientsChanged();
          response.json({ client });
        });
      },
    );
  }

  if (scope.includeSettings && emailSettings && requireAdmin) {
    router.get("/settings/runtime-policy", async (request, response, next) => {
      await withActor(request, response, next, async (auth) => {
        requireAdmin(auth.actor);
        response.json({ settings: await emailSettings.getView() });
      });
    });

    router.get(
      "/settings/runtime-policy/audit-logs",
      async (request, response, next) => {
        await withActor(request, response, next, async (auth) => {
          requireAdmin(auth.actor);
          const limit = Math.min(
            100,
            Math.max(1, Number(request.query["limit"] ?? 50) || 50),
          );
          response.json({
            auditLogs: await emailSettings.listAuditLogs(limit),
          });
        });
      },
    );

    router.put(
      "/settings/runtime-policy",
      jsonParser,
      async (request, response, next) => {
        await withMutation(request, response, next, async (auth) => {
          requireAdmin(auth.actor);
          const settings = await emailSettings.update(
            request.body ?? {},
            auth.actor,
          );
          response.json({ settings });
        });
      },
    );

    router.post(
      "/settings/runtime-policy/email/test",
      jsonParser,
      async (request, response, next) => {
        await withMutation(request, response, next, async (auth) => {
          requireAdmin(auth.actor);
          const settings = await emailSettings.sendTest(
            request.body ?? {},
            auth.actor,
          );
          response.json({ settings });
        });
      },
    );

    router.post(
      "/settings/runtime-policy/restart",
      async (request, response, next) => {
        await withMutation(request, response, next, async (auth) => {
          requireAdmin(auth.actor);
          if (!onRestartRequested) {
            throw new ClientManagementError(
              503,
              "restart_unavailable",
              "service restart is not available in this deployment",
            );
          }
          response.status(202).json({ restarting: true });
          response.once("finish", onRestartRequested);
        });
      },
    );
  }
}
