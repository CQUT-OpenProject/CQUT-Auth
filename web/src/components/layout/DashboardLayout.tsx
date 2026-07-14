import React, { useState } from "react";
import {
  Layout,
  Menu,
  Select,
  Button,
  Space,
  Drawer,
  Typography,
  Breadcrumb,
  Divider,
  theme,
  Badge,
} from "antd";
import {
  MenuUnfoldOutlined,
  MenuFoldOutlined,
  ProjectOutlined,
  TeamOutlined,
  DesktopOutlined,
  AuditOutlined,
  SafetyCertificateOutlined,
  MailOutlined,
  LogoutOutlined,
  SunOutlined,
  MoonOutlined,
} from "@ant-design/icons";
import { useProject } from "../../contexts/project-context";
import { useNavigate, useLocation, useParams, Outlet } from "react-router-dom";
import { useGetIdentity, useLogout } from "@refinedev/core";
import { useThemeMode } from "../../contexts/theme-context";
import logoMonoLight from "../../assets/logo-mono-light.svg";
import logoColor from "../../assets/logo-color.svg";

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export const DashboardLayout: React.FC = () => {
  const { projects, activeProject, selectProject } = useProject();
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams<{ projectId: string }>();
  const { data: identity } = useGetIdentity<any>();
  const { mutate: logout } = useLogout();
  const { themeMode, toggleTheme } = useThemeMode();
  const { token } = theme.useToken();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileVisible, setMobileVisible] = useState(false);

  const handleProjectSelect = (value: string) => {
    selectProject(value);
    navigate(`/projects/${encodeURIComponent(value)}/overview`);
  };

  const getBreadcrumbs = () => {
    const paths = location.pathname.split("/").filter(Boolean);
    const breadcrumbItems = [
      { title: "管理台", key: "manage", onClick: () => navigate("/projects") },
    ];

    if (paths.includes("projects")) {
      breadcrumbItems.push({
        title: "项目列表",
        key: "projects",
        onClick: () => navigate("/projects"),
      });
      if (activeProject) {
        breadcrumbItems.push({
          title: activeProject.name,
          key: activeProject.projectId,
          onClick: () =>
            navigate(
              `/projects/${encodeURIComponent(activeProject.projectId)}/overview`,
            ),
        });
      }
    }

    if (paths.includes("admin")) {
      breadcrumbItems.push({
        title: "管理员面板",
        key: "admin",
        onClick: () => navigate("/admin/reviews"),
      });
    }

    return breadcrumbItems;
  };

  const getMenuItems = () => {
    const items: any[] = [
      {
        key: "projects-list",
        icon: <ProjectOutlined />,
        label: "项目列表",
        onClick: () => navigate("/projects"),
      },
    ];

    if (activeProject) {
      items.push({
        key: "project-group",
        label: `${activeProject.name} (当前)`,
        type: "group",
        children: [
          {
            key: "overview",
            icon: <DesktopOutlined />,
            label: "项目概览",
            onClick: () =>
              navigate(
                `/projects/${encodeURIComponent(activeProject.projectId)}/overview`,
              ),
          },
          {
            key: "clients",
            icon: <DesktopOutlined />,
            label: "OIDC 客户端",
            onClick: () =>
              navigate(
                `/projects/${encodeURIComponent(activeProject.projectId)}/clients`,
              ),
          },
          {
            key: "members",
            icon: <TeamOutlined />,
            label: "成员管理",
            onClick: () =>
              navigate(
                `/projects/${encodeURIComponent(activeProject.projectId)}/members`,
              ),
          },
          {
            key: "audit",
            icon: <AuditOutlined />,
            label: "审计日志",
            onClick: () =>
              navigate(
                `/projects/${encodeURIComponent(activeProject.projectId)}/audit`,
              ),
          },
        ],
      });
    }

    if (identity?.isAdmin) {
      items.push({
        key: "admin-group",
        label: "系统管理员",
        type: "group",
        children: [
          {
            key: "reviews",
            icon: <SafetyCertificateOutlined />,
            label: "全局待审核",
            onClick: () => navigate("/admin/reviews"),
          },
          {
            key: "email-settings",
            icon: <MailOutlined />,
            label: "邮件设置",
            onClick: () => navigate("/admin/settings/email"),
          },
        ],
      });
    }

    return items;
  };

  const menuElement = (
    <Menu
      theme="dark"
      mode="inline"
      selectedKeys={[location.pathname]}
      items={getMenuItems()}
      style={{ borderRight: 0 }}
    />
  );

  return (
    <Layout style={{ minHeight: "100vh" }}>
      {/* Desktop Sider */}
      <Sider
        breakpoint="lg"
        collapsedWidth="0"
        onBreakpoint={(broken) => {
          // If screen size goes past breakpoint, handle mobile drawer switcher
        }}
        trigger={null}
        collapsible
        collapsed={collapsed}
        style={{
          overflow: "auto",
          height: "100vh",
          position: "sticky",
          top: 0,
          left: 0,
        }}
      >
        <div
          style={{ padding: "16px", display: "flex", justifyContent: "center" }}
        >
          <img
            src={logoMonoLight}
            alt="CQUT-Auth"
            style={{ height: "40px", maxWidth: "100%" }}
          />
        </div>
        {menuElement}
      </Sider>

      <Layout>
        <Header
          style={{
            background: token.colorBgContainer,
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Space>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => {
                setCollapsed(!collapsed);
                // Also trigger mobile drawer if screen width is narrow
                if (window.innerWidth < 992) {
                  setMobileVisible(true);
                }
              }}
            />
            {projects.length > 0 && (
              <Select
                value={activeProject?.projectId}
                onChange={handleProjectSelect}
                style={{ width: 200 }}
                placeholder="切换项目"
              >
                {projects.map((p) => (
                  <Select.Option key={p.projectId} value={p.projectId}>
                    {p.name}
                  </Select.Option>
                ))}
              </Select>
            )}
          </Space>

          <Space size="middle">
            {identity && (
              <Space size={8}>
                <Space size={4}>
                  <Text strong>{identity.displayName}</Text>
                  {identity.isAdmin && (
                    <Badge status="success" text="系统管理员" />
                  )}
                </Space>
                <Text
                  type="secondary"
                  copyable={{ tooltips: ["复制 Subject ID", "已复制"] }}
                  style={{ fontSize: "12px", fontFamily: "monospace" }}
                >
                  {identity.subjectId}
                </Text>
              </Space>
            )}
            <Button
              type="text"
              icon={themeMode === "dark" ? <SunOutlined /> : <MoonOutlined />}
              onClick={toggleTheme}
              style={{
                fontSize: "16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            />
            <Button
              type="text"
              danger
              icon={<LogoutOutlined />}
              onClick={() => logout()}
            >
              退出
            </Button>
          </Space>
        </Header>

        {/* Mobile Drawer */}
        <Drawer
          title={
            <img src={logoColor} alt="CQUT-Auth" style={{ height: "32px" }} />
          }
          placement="left"
          onClose={() => setMobileVisible(false)}
          open={mobileVisible}
          bodyStyle={{ padding: 0, background: "#0b1f33" }}
        >
          {menuElement}
        </Drawer>

        <Content style={{ margin: "24px 24px 0", overflow: "initial" }}>
          <div style={{ marginBottom: "16px" }}>
            <Breadcrumb
              items={getBreadcrumbs().map((b) => ({
                title: <a onClick={b.onClick}>{b.title}</a>,
              }))}
            />
          </div>
          <div style={{ minHeight: 360 }}>
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
};
