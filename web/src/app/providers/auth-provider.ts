import type { AuthProvider } from "@refinedev/core";
import { request, setCsrfToken } from "../../api/client";
import type { AuthContext } from "../../api/types";

export const authProvider: AuthProvider = {
  login: async ({ account, password }) => {
    try {
      // The login CSRF token is bound to the anonymous nonce cookie. Refresh it
      // immediately before submitting so a stale page or an earlier provider
      // call cannot submit without the matching header.
      const context = await request<AuthContext>("/auth/context");
      setCsrfToken(context.csrfToken);
      const data = await request<AuthContext>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ account, password }),
      });
      if (data.authenticated) {
        setCsrfToken(data.csrfToken);
        return {
          success: true,
          redirectTo: "/projects",
        };
      }
      return {
        success: false,
        error: new Error("登录失败"),
      };
    } catch (error: any) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error("登录失败"),
      };
    }
  },
  logout: async () => {
    try {
      await request("/auth/logout", { method: "POST" });
    } catch {
      // Ignore logout errors
    } finally {
      setCsrfToken(undefined);
    }
    return {
      success: true,
      redirectTo: "/login",
    };
  },
  check: async () => {
    try {
      const data = await request<AuthContext>("/auth/context");
      setCsrfToken(data.csrfToken);
      if (data.authenticated) {
        return {
          authenticated: true,
        };
      }
      return {
        authenticated: false,
        redirectTo: "/login",
      };
    } catch {
      return {
        authenticated: false,
        redirectTo: "/login",
      };
    }
  },
  onError: async (error: any) => {
    if (error?.status === 401) {
      setCsrfToken(undefined);
      return {
        logout: true,
        redirectTo: "/login",
      };
    }
    return { error };
  },
  getIdentity: async () => {
    try {
      const data = await request<AuthContext>("/auth/context");
      if (data.authenticated) {
        return data.user;
      }
      return null;
    } catch {
      return null;
    }
  },
};
