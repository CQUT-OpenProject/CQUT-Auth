import type { ResourceProps } from "@refinedev/core";

export const resources: ResourceProps[] = [
  {
    name: "projects",
    list: "/manage/projects",
  },
  {
    name: "clients",
    list: "/manage/projects/:projectId/clients",
    create: "/manage/projects/:projectId/clients/new",
    show: "/manage/projects/:projectId/clients/:id",
  },
  {
    name: "projectMembers",
    list: "/manage/projects/:projectId/members",
  },
  {
    name: "projectAuditLogs",
    list: "/manage/projects/:projectId/audit",
  },
  {
    name: "adminReviews",
    list: "/manage/admin/reviews",
  },
];
