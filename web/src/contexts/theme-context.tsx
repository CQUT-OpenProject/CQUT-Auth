import React, { createContext, useContext, useState, useEffect } from "react";

export type ThemeMode = "light" | "dark";

interface ThemeContextType {
  themeMode: ThemeMode;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeModeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("themeMode");
    if (saved === "light" || saved === "dark") return saved;
    // default to user's system preference
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      return "dark";
    }
    return "light";
  });

  useEffect(() => {
    localStorage.setItem("themeMode", themeMode);
    if (themeMode === "dark") {
      document.body.classList.add("dark-theme");
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.body.classList.remove("dark-theme");
      document.documentElement.removeAttribute("data-theme");
    }
  }, [themeMode]);

  const toggleTheme = () => {
    setThemeMode((prev) => (prev === "light" ? "dark" : "light"));
  };

  return (
    <ThemeContext.Provider value={{ themeMode, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useThemeMode = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useThemeMode must be used within a ThemeModeProvider");
  }
  return context;
};
