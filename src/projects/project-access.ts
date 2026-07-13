import { ClientManagementError } from "../clients/client-management.service.js";
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

export class ProjectAccessService {
  constructor(private readonly repository: ProjectRepository) {}

  async require(actor: ProjectActor, projectId: string, action: ProjectAction) {
    const project = await this.repository.findProject(projectId);
    if (!project) this.notFound();
    const role = await this.repository.findProjectRole(
      projectId,
      actor.subjectId,
    );
    if (projectId === SYSTEM_PROJECT_ID) {
      if (!actor.isAdmin) this.notFound();
      return { project, role: null };
    }
    if (!role && !actor.isAdmin) this.notFound();
    if (!this.allowed(actor, role, action)) this.denied();
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
    return { project, role };
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
      if (!role && !actor.isAdmin) return false;
      if (project.status === "archived" && action !== "view") {
        return (
          actor.isAdmin &&
          [
            "review",
            "revoke_authorizations",
            "revoke_secret",
            "disable_client",
          ].includes(action)
        );
      }
      return this.allowed(actor, role, action);
    });
  }

  private allowed(
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

  private notFound(): never {
    throw new ClientManagementError(404, "not_found", "project not found");
  }

  private denied(): never {
    throw new ClientManagementError(
      403,
      "access_denied",
      "project role is insufficient",
    );
  }
}
