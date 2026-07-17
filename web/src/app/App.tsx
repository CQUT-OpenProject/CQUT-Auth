import React from "react";
import { Refine } from "@refinedev/core";
import { dataProvider } from "./providers/data-provider";
import { authProvider } from "./providers/auth-provider";
import { accessControlProvider } from "./providers/access-control-provider";
import { notificationProvider } from "./providers/notification-provider";
import { resources } from "./resources";
import { AppRouter } from "./router";
import { BrowserRouter } from "react-router-dom";
import routerProvider from "@refinedev/react-router";
import { ConfigProvider, App as AntdApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { getThemeConfig } from "../theme/theme";
import { ThemeModeProvider, useThemeMode } from "../contexts/theme-context";

export const AppContent: React.FC = () => {
  const { themeMode } = useThemeMode();
  const dynamicTheme = getThemeConfig(themeMode === "dark");

  return (
    <ConfigProvider locale={zhCN} theme={dynamicTheme}>
      <AntdApp>
        <Refine
          routerProvider={routerProvider}
          dataProvider={dataProvider}
          authProvider={authProvider}
          accessControlProvider={accessControlProvider}
          notificationProvider={notificationProvider}
          resources={resources}
          options={{
            syncWithLocation: true,
            warnWhenUnsavedChanges: false,
          }}
        >
          <AppRouter />
        </Refine>
      </AntdApp>
    </ConfigProvider>
  );
};

export const App: React.FC = () => {
  return (
    <BrowserRouter basename="/manage">
      <ThemeModeProvider>
        <AppContent />
      </ThemeModeProvider>
    </BrowserRouter>
  );
};
