import type { DataProvider } from "@refinedev/core";
import { request } from "../../api/client";
import type { EmailSettingsView } from "../../api/types";

export const dataProvider: DataProvider = {
  getList: async ({ resource, meta, filters, pagination }) => {
    const projectId = meta?.projectId;

    if (resource === "projects") {
      const res = await request<{ projects: any[] }>("/projects");
      return {
        data: res.projects,
        total: res.projects.length,
      };
    }

    if (resource === "projectMembers") {
      if (!projectId) throw new Error("projectId is required in meta");
      const res = await request<{ members: any[] }>(
        `/projects/${encodeURIComponent(projectId)}/members`,
      );
      return {
        data: res.members,
        total: res.members.length,
      };
    }

    if (resource === "clients") {
      if (!projectId) throw new Error("projectId is required in meta");
      const res = await request<{ clients: any[] }>(
        `/projects/${encodeURIComponent(projectId)}/clients`,
      );
      return {
        data: res.clients,
        total: res.clients.length,
      };
    }

    if (resource === "projectAuditLogs") {
      if (!projectId) throw new Error("projectId is required in meta");
      // Read query params from meta or pagination filters
      const limit = pagination?.current ? pagination.pageSize : 50;
      const beforeId = meta?.beforeId;
      const query = new URLSearchParams();
      if (limit) query.set("limit", String(limit));
      if (beforeId) query.set("beforeId", String(beforeId));

      const queryString = query.toString() ? `?${query.toString()}` : "";
      const res = await request<{ auditLogs: any[] }>(
        `/projects/${encodeURIComponent(projectId)}/audit-logs${queryString}`,
      );
      return {
        data: res.auditLogs,
        total: res.auditLogs.length, // backend pagination uses cursor, so length of returned logs is appropriate
      };
    }

    if (resource === "adminReviews") {
      const res = await request<{ clients: any[] }>("/admin/reviews");
      return {
        data: res.clients,
        total: res.clients.length,
      };
    }

    throw new Error(`Unhandled resource: ${resource}`);
  },

  getOne: async ({ resource, id, meta }) => {
    const projectId = meta?.projectId;

    if (resource === "projects") {
      const res = await request<{ project: any }>(
        `/projects/${encodeURIComponent(id.toString())}`,
      );
      return {
        data: res.project,
      };
    }

    if (resource === "clients") {
      if (!projectId) throw new Error("projectId is required in meta");
      const res = await request<{ client: any }>(
        `/projects/${encodeURIComponent(projectId)}/clients/${encodeURIComponent(id.toString())}`,
      );
      return {
        data: res.client,
      };
    }

    if (resource === "emailSettings") {
      const res = await request<{ settings: EmailSettingsView }>(
        "/settings/email",
      );
      return {
        data: { ...res.settings, id: "email" },
      };
    }

    throw new Error(`Unhandled resource or missing ID: ${resource}`);
  },

  create: async ({ resource, variables, meta }) => {
    const projectId = meta?.projectId;

    if (resource === "projects") {
      const res = await request<{ project: any }>("/projects", {
        method: "POST",
        body: JSON.stringify(variables),
      });
      return {
        data: res.project,
      };
    }

    if (resource === "projectMembers") {
      if (!projectId) throw new Error("projectId is required in meta");
      const res = await request<{ project: any }>(
        `/projects/${encodeURIComponent(projectId)}/members`,
        {
          method: "POST",
          body: JSON.stringify(variables),
        },
      );
      return {
        data: res.project,
      };
    }

    if (resource === "clients") {
      if (!projectId) throw new Error("projectId is required in meta");
      const res = await request<{ client: any; clientSecret?: string }>(
        `/projects/${encodeURIComponent(projectId)}/clients`,
        {
          method: "POST",
          body: JSON.stringify(variables),
        },
      );
      return {
        // Return both client and clientSecret for single-time secret display
        data: {
          ...res.client,
          clientSecret: res.clientSecret,
        },
      };
    }

    throw new Error(`Unhandled resource create: ${resource}`);
  },

  update: async ({ resource, id, variables, meta }) => {
    const projectId = meta?.projectId;

    if (resource === "projects") {
      const res = await request<{ project: any }>(
        `/projects/${encodeURIComponent(id.toString())}`,
        {
          method: "PATCH",
          body: JSON.stringify(variables),
        },
      );
      return {
        data: res.project,
      };
    }

    if (resource === "projectMembers") {
      if (!projectId) throw new Error("projectId is required in meta");
      const res = await request<{ project: any }>(
        `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(id.toString())}`,
        {
          method: "PATCH",
          body: JSON.stringify(variables),
        },
      );
      return {
        data: res.project,
      };
    }

    if (resource === "clients") {
      if (!projectId) throw new Error("projectId is required in meta");
      const res = await request<{ client: any }>(
        `/projects/${encodeURIComponent(projectId)}/clients/${encodeURIComponent(id.toString())}`,
        {
          method: "PATCH",
          body: JSON.stringify(variables),
        },
      );
      return {
        data: res.client,
      };
    }

    if (resource === "emailSettings") {
      const res = await request<{ settings: EmailSettingsView }>(
        "/settings/email",
        {
          method: "PUT",
          body: JSON.stringify(variables),
        },
      );
      return {
        data: { ...res.settings, id: "email" },
      };
    }

    throw new Error(`Unhandled resource update: ${resource}`);
  },

  deleteOne: async ({ resource, id, variables, meta }) => {
    const projectId = meta?.projectId;

    if (resource === "projectMembers") {
      if (!projectId) throw new Error("projectId is required in meta");
      const res = await request<{ project: any }>(
        `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(id.toString())}`,
        {
          method: "DELETE",
          body: JSON.stringify(variables),
        },
      );
      return {
        data: res.project,
      };
    }

    throw new Error(`Unhandled deleteOne for resource: ${resource}`);
  },

  getApiUrl: () => {
    return "/api/management";
  },

  custom: async ({ url, method, payload }) => {
    if (url === "/settings/email/test" && method === "post") {
      const res = await request<{ settings: EmailSettingsView }>(url, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return {
        data: { ...res.settings, id: "email" },
      };
    }
    throw new Error(`Unhandled custom request: ${method.toUpperCase()} ${url}`);
  },
};
