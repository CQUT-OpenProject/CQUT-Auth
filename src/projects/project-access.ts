import { ClientManagementError } from "../management/management-error.js";
import {
  SYSTEM_PROJECT_ID,
  type ProjectRecord,
  type ProjectRepository,
  type ProjectRole,
} from "../persistence/contracts.js";

export type ProjectActor = {
  subjectId: string;
  isAdmin: boolean;
  sourceIp?: string;
};

export type ProjectAction =
  | "view"
  | "manage_project"
  | "manage_members"
  | "write_client"
  | "rotate_secret"
  | "revoke_authorizations"
  | "revoke_secret"
  | "disable_client"
  | "review";

export type ProjectWriteAuthorization = {
  actor: ProjectActor;
  projectId: string;
  action: Exclude<ProjectAction, "view" | "manage_project" | "manage_members">;
};

export function assertProjectAccess(
  actor: ProjectActor,
  project: ProjectRecord | null,
  role: ProjectRole | null,
  action: ProjectAction,
) {
  if (!project) notFound();
  if (project.projectId === SYSTEM_PROJECT_ID) {
    if (!actor.isAdmin) notFound();
    return;
  }
  if (!role && !actor.isAdmin) notFound();
  if (!allowed(actor, role, action)) denied();
  if (
    project.status === "archived" &&
    action !== "view" &&
    action !== "review" &&
    !(
      actor.isAdmin &&
      ["revoke_authorizations", "revoke_secret", "disable_client"].includes(
        action,
      )
    )
  ) {
    throw new ClientManagementError(
      409,
      "project_archived",
      "archived projects are read-only",
    );
  }
}

export class ProjectAccessService {
  constructor(private readonly repository: ProjectRepository) {}

  async require(actor: ProjectActor, projectId: string, action: ProjectAction) {
    const project = await this.repository.findProject(projectId);
    if (!project) notFound();
    const role = await this.repository.findProjectRole(
      projectId,
      actor.subjectId,
    );
    assertProjectAccess(actor, project, role, action);
    return {
      project,
      role: projectId === SYSTEM_PROJECT_ID ? null : role,
    };
  }

  capabilities(
    actor: ProjectActor,
    project: ProjectRecord,
    role: ProjectRole | null,
  ) {
    const actions: ProjectAction[] = [
      "view",
      "manage_project",
      "manage_members",
      "write_client",
      "rotate_secret",
      "revoke_authorizations",
      "revoke_secret",
      "disable_client",
      "review",
    ];
    return actions.filter((action) => {
      if (project.projectId === SYSTEM_PROJECT_ID)
        return actor.isAdmin && action !== "manage_members";
      try {
        assertProjectAccess(actor, project, role, action);
        return true;
      } catch {
        return false;
      }
    });
  }
}

function allowed(
  actor: ProjectActor,
  role: ProjectRole | null,
  action: ProjectAction,
) {
  if (action === "view") return !!role || actor.isAdmin;
  if (action === "review") return actor.isAdmin;
  if (["revoke_secret", "disable_client"].includes(action))
    return role === "owner" || actor.isAdmin;
  if (["manage_project", "manage_members"].includes(action))
    return role === "owner";
  return role === "owner" || role === "maintainer";
}

function notFound(): never {
  throw new ClientManagementError(404, "not_found", "project not found");
}

function denied(): never {
  throw new ClientManagementError(
    403,
    "access_denied",
    "project role is insufficient",
  );
}
