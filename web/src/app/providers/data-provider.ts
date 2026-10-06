import type { DataProvider } from "@refinedev/core";
import { request } from "../../api/client";

async function unsupportedMutation(): Promise<never> {
  throw new Error("Use request() for management mutations");
}

// Client reads use Refine's query cache. Other pages and all mutations use request().
export const dataProvider: DataProvider = {
  getList: async ({ resource, meta }) => {
    if (resource !== "clients")
      throw new Error(`Unhandled resource: ${resource}`);
    const projectId = meta?.projectId;
    if (!projectId) throw new Error("projectId is required in meta");
    const res = await request<{ clients: any[] }>(
      `/projects/${encodeURIComponent(projectId)}/clients`,
    );
    return { data: res.clients, total: res.clients.length };
  },
  getOne: async ({ resource, id, meta }) => {
    if (resource !== "clients")
      throw new Error(`Unhandled resource: ${resource}`);
    const projectId = meta?.projectId;
    if (!projectId) throw new Error("projectId is required in meta");
    const res = await request<{ client: any }>(
      `/projects/${encodeURIComponent(projectId)}/clients/${encodeURIComponent(id.toString())}`,
    );
    return { data: res.client };
  },
  create: unsupportedMutation,
  update: unsupportedMutation,
  deleteOne: unsupportedMutation,
  getApiUrl: () => "/api/management",
};
