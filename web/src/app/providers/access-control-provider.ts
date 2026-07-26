import type { AccessControlProvider } from "@refinedev/core";
import { request, setCsrfToken } from "../../api/client";
import type { AuthContext, Project, ProjectAction } from "../../api/types";

// Dynamic active project reference for global access control
let activeProject: Project | null = null;
let currentUser: any = null;

export function setActiveProjectForAccessControl(project: Project | null) {
  activeProject = project;
}

export function setCurrentUserForAccessControl(user: any) {
  currentUser = user;
}

export const accessControlProvider: AccessControlProvider = {
  can: async ({ resource, action, params }) => {
    // If user is not logged in, deny all
    if (!currentUser) {
      try {
        const data = await request<AuthContext>("/auth/context");
        setCsrfToken(data.csrfToken);
        if (data.authenticated) {
          currentUser = data.user;
        } else {
          return { can: false, reason: "Unauthorized" };
        }
      } catch {
        return { can: false, reason: "Unauthorized" };
      }
    }

    // Global admin views
    if (
      resource === "adminReviews" ||
      resource === "adminProjects" ||
      resource === "systemSettings"
    ) {
      return { can: !!currentUser?.isAdmin };
    }

    // Standard resources or custom capabilities
    const project = activeProject;

    // Admin has global capabilities even if they are not a project member, except where the matrix says "作为成员时" (when they are a member)
    // Actually, matrix in README says:
    // - 查看项目、成员、客户端和审计: owner, maintainer, viewer, 管理员 (全局)
    // - 修改项目、管理成员、转移所有权: owner, 管理员 (作为成员时) -> so they must be owner or have capability
    const isArchived = project?.status === "archived";
    const isAdmin = !!currentUser?.isAdmin;
    const capabilities: ProjectAction[] = project?.capabilities ?? [];
    let requiredCapability: ProjectAction | null = null;

    if (action === "list" || action === "show" || action === "view") {
      if (isAdmin) return { can: true };
      return { can: capabilities.includes("view") };
    }

    if (resource === "projects") {
      if (action === "create") {
        return { can: true };
      }
      if (action === "edit" || action === "archive") {
        requiredCapability = "manage_project";
      }
    } else if (resource === "projectMembers") {
      if (
        action === "create" ||
        action === "edit" ||
        action === "delete" ||
        action === "transfer"
      ) {
        requiredCapability = "manage_members";
      }
    } else if (resource === "clients") {
      if (
        action === "create" ||
        action === "edit" ||
        action === "saveRevision"
      ) {
        requiredCapability = "write_client";
      } else if (action === "rotate_secret") {
        requiredCapability = "rotate_secret";
      } else if (action === "revoke_authorizations") {
        requiredCapability = "revoke_authorizations";
      } else if (action === "revoke_secret") {
        requiredCapability = "revoke_secret";
      } else if (action === "disable_client") {
        requiredCapability = "disable_client";
      }
    }

    if (!requiredCapability && capabilities.includes(action as ProjectAction)) {
      requiredCapability = action as ProjectAction;
    }

    if (!requiredCapability) {
      return { can: false, reason: "No matching capability mapping" };
    }

    if (isArchived) {
      if (isAdmin) {
        const allowedEmergency = [
          "disable_client",
          "revoke_secret",
          "revoke_authorizations",
          "view",
        ];
        if (allowedEmergency.includes(requiredCapability)) {
          return { can: true };
        }
      }
      return { can: false, reason: "Archived project is read-only" };
    }

    if (capabilities.includes(requiredCapability)) {
      return { can: true };
    }

    if (isAdmin) {
      const adminGlobalCapabilities = [
        "view",
        "revoke_secret",
        "disable_client",
      ];
      if (adminGlobalCapabilities.includes(requiredCapability)) {
        return { can: true };
      }
    }

    return {
      can: false,
      reason: `Lacks required capability: ${requiredCapability}`,
    };
  },
};
