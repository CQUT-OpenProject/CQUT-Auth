import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { DashboardLayout } from "../components/layout/DashboardLayout";
import { Login } from "../pages/auth/Login";
import { ProjectList } from "../pages/projects/ProjectList";
import { ProjectOverview } from "../pages/projects/ProjectOverview";
import { MemberManager } from "../pages/members/MemberManager";
import { ClientList } from "../pages/clients/ClientList";
import { ClientCreate } from "../pages/clients/ClientCreate";
import { ClientDetail } from "../pages/clients/ClientDetail";
import { ProjectAudit } from "../pages/audit/ProjectAudit";
import { AdminReviews } from "../pages/admin/AdminReviews";
import { SystemSettings } from "../pages/admin/SystemSettings";
import { Authenticated, CanAccess } from "@refinedev/core";
import { Alert, Card } from "antd";

export const AppRouter: React.FC = () => {
  return (
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
            <DashboardLayout />
          </Authenticated>
        }
      >
        <Route index element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectList />} />
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
          path="/projects/:projectId/clients/:clientId/audit"
          element={<ClientDetail />}
        />

        {/* Project logs */}
        <Route path="/projects/:projectId/audit" element={<ProjectAudit />} />

        {/* Admin Reviews */}
        <Route path="/admin/reviews" element={<AdminReviews />} />
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
  );
};
