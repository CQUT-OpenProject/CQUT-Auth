import React, { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router";
import { Login } from "../pages/auth/Login";
import { Authenticated, CanAccess } from "@refinedev/core";
import { Alert, Card } from "antd";
import { ProjectProvider } from "../contexts/project-context";

const DashboardLayout = lazy(() =>
  import("../components/layout/DashboardLayout").then((module) => ({
    default: module.DashboardLayout,
  })),
);

const ProjectList = lazy(() =>
  import("../pages/projects/ProjectList").then((module) => ({
    default: module.ProjectList,
  })),
);

const ProjectOverview = lazy(() =>
  import("../pages/projects/ProjectOverview").then((module) => ({
    default: module.ProjectOverview,
  })),
);

const MemberManager = lazy(() =>
  import("../pages/members/MemberManager").then((module) => ({
    default: module.MemberManager,
  })),
);

const ClientList = lazy(() =>
  import("../pages/clients/ClientList").then((module) => ({
    default: module.ClientList,
  })),
);

const ClientCreate = lazy(() =>
  import("../pages/clients/ClientCreate").then((module) => ({
    default: module.ClientCreate,
  })),
);

const ClientDetail = lazy(() =>
  import("../pages/clients/ClientDetail").then((module) => ({
    default: module.ClientDetail,
  })),
);

const ProjectAudit = lazy(() =>
  import("../pages/audit/ProjectAudit").then((module) => ({
    default: module.ProjectAudit,
  })),
);

const SystemSettings = lazy(() =>
  import("../pages/admin/SystemSettings").then((module) => ({
    default: module.SystemSettings,
  })),
);

export const AppRouter: React.FC = () => {
  return (
    <Suspense fallback={<Card loading aria-label="页面加载中" />}>
      <Routes>
        {/* Auth Routes */}
        <Route path="/login" element={<Login />} />

        {/* Main App Layout under Auth Guards */}
        <Route
          element={
            <Authenticated
              key="authenticated-routes"
              fallback={<Navigate to="/login" replace />}
            >
              <ProjectProvider>
                <DashboardLayout />
              </ProjectProvider>
            </Authenticated>
          }
        >
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectList />} />
          <Route
            path="/projects/system/members"
            element={<Navigate to="/projects/system/clients" replace />}
          />
          <Route
            path="/projects/:projectId/overview"
            element={<ProjectOverview />}
          />
          <Route
            path="/projects/:projectId/members"
            element={<MemberManager />}
          />
          <Route path="/projects/:projectId/clients" element={<ClientList />} />
          <Route
            path="/projects/system/clients/new"
            element={<Navigate to="/projects/system/clients" replace />}
          />
          <Route
            path="/projects/:projectId/clients/new"
            element={<ClientCreate />}
          />

          {/* Client details paths synchronized to tabs */}
          <Route
            path="/projects/:projectId/clients/:clientId/overview"
            element={<ClientDetail />}
          />
          <Route
            path="/projects/:projectId/clients/:clientId/configuration"
            element={<ClientDetail />}
          />
          <Route
            path="/projects/:projectId/clients/:clientId/secrets"
            element={<ClientDetail />}
          />
          <Route
            path="/projects/:projectId/clients/:clientId/safety"
            element={<ClientDetail />}
          />
          <Route
            path="/projects/:projectId/clients/:clientId/audit"
            element={<ClientDetail />}
          />

          {/* Project logs */}
          <Route path="/projects/:projectId/audit" element={<ProjectAudit />} />

          <Route
            path="/admin/settings/system"
            element={
              <CanAccess
                resource="systemSettings"
                action="edit"
                fallback={
                  <Card title="系统设置">
                    <Alert
                      type="error"
                      showIcon
                      message="需要管理员权限"
                      description="仅系统管理员可以查看和修改系统设置。"
                    />
                  </Card>
                }
              >
                <SystemSettings />
              </CanAccess>
            }
          />
          <Route
            path="/admin/projects"
            element={<Navigate to="/projects" replace />}
          />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </Suspense>
  );
};
