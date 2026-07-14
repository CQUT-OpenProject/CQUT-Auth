import type { ResourceProps } from "@refinedev/core";

export const resources: ResourceProps[] = [
  {
    name: "projects",
    list: "/projects",
  },
  {
    name: "clients",
    list: "/projects/:projectId/clients",
    create: "/projects/:projectId/clients/new",
    show: "/projects/:projectId/clients/:id",
  },
  {
    name: "projectMembers",
    list: "/projects/:projectId/members",
  },
  {
    name: "projectAuditLogs",
    list: "/projects/:projectId/audit",
  },
  {
    name: "adminReviews",
    list: "/admin/reviews",
  },
  {
    name: "emailSettings",
    list: "/admin/settings/email",
  },
];
