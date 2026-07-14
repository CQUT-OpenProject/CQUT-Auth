import type { AccessControlProvider } from "@refinedev/core";
import { request } from "../../api/client";
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
    if (resource === "adminReviews" || resource === "adminProjects") {
      return { can: !!currentUser?.isAdmin };
    }

    // Standard resources or custom capabilities
    const project = activeProject;

    // Admin has global capabilities even if they are not a project member, except where the matrix says "作为成员时" (when they are a member)
    // Actually, matrix in README says:
    // - 查看项目、成员、客户端和审计: owner, maintainer, viewer, 管理员 (全局)
    // - 修改项目、管理成员、转移所有权: owner, 管理员 (作为成员时) -> so they must be owner or have capability
    // - 创建/修改客户端及提交 Revision: owner, maintainer, 管理员 (系统项目或作为成员时)
    // - 轮换 Secret、撤销授权: owner, maintainer, 管理员 (紧急处置)
    // - 撤销指定 Secret、紧急停用: owner, 管理员 (全局)
    // - 批准/拒绝 Revision: 管理员 (全局)

    // So if project is archived:
    // "归档项目只读且不影响现有 OIDC 客户端运行，仅管理员可继续审核或紧急处置。"
    // This means for archived projects, ordinary members have zero mutating capabilities (read-only).
    const isArchived = project?.status === "archived";
    const isAdmin = !!currentUser?.isAdmin;

    // Check capability list
    const capabilities: ProjectAction[] = project?.capabilities ?? [];

    // Let's resolve capability based on action and resource
    let requiredCapability: ProjectAction | null = null;

    if (action === "list" || action === "show" || action === "view") {
      // Viewing is allowed for project members (having capabilities) or global admins
      if (isAdmin) return { can: true };
      return { can: capabilities.includes("view") };
    }

    // Map standard Refine actions to capabilities
    if (resource === "projects") {
      if (action === "create") {
        // Any authenticated user can create projects (subject to quotas)
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
        action === "saveRevision" ||
        action === "submitRevision" ||
        action === "withdrawRevision"
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

    // If explicit project action is passed directly as action
    if (!requiredCapability && capabilities.includes(action as ProjectAction)) {
      requiredCapability = action as ProjectAction;
    }

    if (!requiredCapability) {
      // Default fallback
      return { can: false, reason: "No matching capability mapping" };
    }

    // Archived projects constraint:
    if (isArchived) {
      // "归档项目只读且不影响现有 OIDC 客户端运行，仅管理员可继续审核或紧急处置。"
      // Administrators can do emergency operations (disable_client, revoke_secret, revoke_authorizations, etc.) or review
      if (isAdmin) {
        // Admin is allowed emergency and review actions on archived projects
        const allowedEmergency = [
          "disable_client",
          "revoke_secret",
          "revoke_authorizations",
          "view",
          "review",
        ];
        if (allowedEmergency.includes(requiredCapability)) {
          return { can: true };
        }
      }
      return { can: false, reason: "Archived project is read-only" };
    }

    // Ordinary check
    if (capabilities.includes(requiredCapability)) {
      return { can: true };
    }

    // Admins have global capability for some dangerous operations even if they lack capabilities in the project
    if (isAdmin) {
      const adminGlobalCapabilities = [
        "view",
        "revoke_secret",
        "disable_client",
        "review",
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
