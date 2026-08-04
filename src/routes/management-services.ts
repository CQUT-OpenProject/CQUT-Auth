import type { StaticConfig } from "../config.js";
import { ClientManagementService } from "../clients/client-management.service.js";
import { ManagementSessionService } from "../management/management-session.service.js";
import type { PersistenceModules } from "../persistence/persistence.js";
import { ProjectManagementService } from "../projects/project-management.service.js";

export function createManagementDomainServices(
  config: StaticConfig,
  persistence: Pick<
    PersistenceModules,
    "identity" | "projects" | "clients" | "sessions" | "runtime"
  >,
) {
  const sessions = new ManagementSessionService(
    persistence.sessions,
    persistence.identity,
    config.sessionTtlSeconds,
    config.sessionIdleTtlSeconds,
  );
  const projects = new ProjectManagementService(persistence.projects, {
    limits: {
      maxActiveProjects: config.managementProjectMaxActivePerSubject,
      adminQuotaExempt: config.managementProjectQuotaAdminExempt,
    },
    // Postgres writes client audits into project_audit_logs, so the project
    // audit view already includes them; the memory client repo keeps its own.
    ...(persistence.runtime.hasDatabase()
      ? {}
      : { clientAudits: persistence.clients }),
  });
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
