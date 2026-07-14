import { theme } from "antd";
import type { ThemeConfig } from "antd";

export const getThemeConfig = (isDark: boolean): ThemeConfig => {
  return {
    algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: isDark ? "#177ddc" : "#055088", // Brighter blue for better contrast in dark mode
      colorSuccess: "#52c41a",
      colorWarning: "#faad14",
      colorError: "#ff4d4f",
      colorInfo: isDark ? "#177ddc" : "#055088",
      colorTextBase: isDark ? "#e3e3e3" : "#0b1f33",
      colorBgLayout: isDark ? "#141414" : "#f0f2f5",
      borderRadius: 6,
      fontFamily: "system-ui, PingFang SC, Microsoft YaHei, sans-serif",
    },
    components: {
      Layout: {
        headerBg: isDark ? "#1f1f1f" : "#ffffff",
        headerColor: isDark ? "#ffffff" : "#000000",
        siderBg: "#0b1f33",
      },
      Menu: {
        darkItemBg: "#0b1f33",
        darkItemColor: "rgba(255, 255, 255, 0.65)",
      },
    },
  };
};

// Default static config for backwards compatibility
export const themeConfig = getThemeConfig(false);
