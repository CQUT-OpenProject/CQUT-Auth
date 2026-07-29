import type { StaticConfig } from "../config.js";
import { ClientManagementService } from "../clients/client-management.service.js";
import { ManagementSessionService } from "../management/management-session.service.js";
import type { PersistenceModules } from "../persistence/persistence.js";
import { ProjectManagementService } from "../projects/project-management.service.js";

export function createManagementDomainServices(
  config: StaticConfig,
  persistence: Pick<
    PersistenceModules,
    "identity" | "projects" | "clients" | "sessions"
  >,
) {
  const sessions = new ManagementSessionService(
    persistence.sessions,
    persistence.identity,
    config.sessionTtlSeconds,
    config.sessionIdleTtlSeconds,
  );
  const projects = new ProjectManagementService(
    persistence.projects,
    undefined,
    undefined,
    {
      maxActiveProjects: config.managementProjectMaxActivePerSubject,
      adminQuotaExempt: config.managementProjectQuotaAdminExempt,
    },
    persistence.clients,
  );
  const clients = new ClientManagementService(
    persistence.clients,
    projects.access,
    config.appEnv,
    {
      maxClientsPerProject: config.managementClientMaxPerProject,
      maxClientsPerSubject: config.managementClientMaxPerSubject,
      adminQuotaExempt: config.managementClientQuotaAdminExempt,
      defaultSecretGraceSeconds: config.clientSecretDefaultGraceSeconds,
      maxSecretGraceSeconds: config.clientSecretMaxGraceSeconds,
      minimumSecretRotationIntervalSeconds:
        config.clientSecretRotateMinimumIntervalSeconds,
    },
  );
  return {
    sessions,
    projects,
    clients,
    adminIds: new Set(config.adminSubjectIds),
  };
}
