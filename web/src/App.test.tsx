import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import React from "react";
import { App } from "./app/App";

// Global mutable authentication state for mocking
let apiAuthenticated = true;

// Mock matchMedia for Ant Design layout components in jsdom environment
beforeEach(() => {
  apiAuthenticated = true; // reset to default
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // Deprecated
      removeListener: vi.fn(), // Deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const ownerCapabilities = [
  "view",
  "manage_project",
  "manage_members",
  "write_client",
  "rotate_secret",
  "revoke_authorizations",
  "revoke_secret",
  "disable_client",
];

function project(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project_one",
    name: "Project One",
    description: "Team project",
    status: "active",
    version: 2,
    role: "owner",
    capabilities: ownerCapabilities,
    ...overrides,
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "active-web",
    projectId: "project_one",
    createdBySubjectId: "subj_owner",
    displayName: "Active Web",
    description: "Production client",
    clientType: "web",
    lifecycleStatus: "active",
    activeRevision: {
      revisionId: 1,
      revisionNumber: 1,
      status: "approved",
      version: 2,
      redirectUris: ["https://app.example.com/callback"],
      postLogoutRedirectUris: [],
      scopeWhitelist: ["openid", "profile"],
      rejectionReason: null,
    },
    proposedRevision: null,
    updatedAt: "2026-07-13T00:00:00.000Z",
    clientVersion: 2,
    secrets: [],
    ...overrides,
  };
}

function mockApi(
  options: {
    projects?: ReturnType<typeof project>[];
    isAdmin?: boolean;
    members?: Array<Record<string, unknown>>;
    clients?: ReturnType<typeof client>[];
  } = {},
) {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const projects = options.projects ?? [project()];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      let body: any = undefined;
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string);
        } catch {
          // Ignored
        }
      }
      calls.push({ path, method, body });

      let responseBody: any = {};

      if (path.endsWith("/auth/context")) {
        if (apiAuthenticated) {
          responseBody = {
            authenticated: true,
            csrfToken: "csrf-token-123",
            clientSecretPolicy: {
              defaultGraceSeconds: 3600,
              maxGraceSeconds: 7200,
            },
            user: {
              subjectId: "subj_owner",
              displayName: "Owner",
              isAdmin: !!options.isAdmin,
            },
          };
        } else {
          responseBody = {
            authenticated: false,
            csrfToken: "csrf-token-123",
          };
        }
      } else if (path.endsWith("/auth/login")) {
        responseBody = {
          authenticated: true,
          csrfToken: "csrf-token-123",
          user: {
            subjectId: "subj_owner",
            displayName: "Owner",
            isAdmin: !!options.isAdmin,
          },
          clientSecretPolicy: {
            defaultGraceSeconds: 3600,
            maxGraceSeconds: 7200,
          },
        };
      } else if (path.endsWith("/auth/logout")) {
        responseBody = {};
      } else if (path.endsWith("/projects") && method === "GET") {
        responseBody = { projects };
      } else if (path.endsWith("/projects") && method === "POST") {
        responseBody = {
          project: {
            projectId: "project_new",
            name: body?.name || "New Project",
            description: body?.description || "",
            status: "active",
            version: 1,
            role: "owner",
            capabilities: ownerCapabilities,
          },
        };
      } else if (path.includes("/members") && method === "GET") {
        responseBody = {
          members: options.members ?? [
            {
              projectId: "project_one",
              subjectId: "subj_owner",
              role: "owner",
              createdAt: "2026-07-13T00:00:00.000Z",
              updatedAt: "2026-07-13T00:00:00.000Z",
            },
          ],
        };
      } else if (path.includes("/members") && method === "POST") {
        responseBody = { project: project() };
      } else if (path.includes("/members/") && method === "PATCH") {
        responseBody = { project: project() };
      } else if (path.includes("/members/") && method === "DELETE") {
        responseBody = { project: project() };
      } else if (path.includes("/ownership/transfer") && method === "POST") {
        responseBody = { project: project() };
      } else if (path.includes("/audit-logs")) {
        responseBody = {
          auditLogs: [
            {
              id: 1,
              projectId: "project_one",
              clientId: "active-web",
              subjectId: "subj_owner",
              action: "client_created",
              details: { ip: "127.0.0.1" },
              createdAt: "2026-07-13T00:00:00.000Z",
            },
          ],
        };
      } else if (path.endsWith("/clients") && method === "GET") {
        responseBody = {
          clients: options.clients ?? [client()],
        };
      } else if (path.endsWith("/clients") && method === "POST") {
        responseBody = {
          client: client({
            clientId: "new-client",
            lifecycleStatus: "draft",
            activeRevision: null,
            proposedRevision: {
              revisionId: 2,
              revisionNumber: 1,
              status: "draft",
              version: 1,
              redirectUris: body?.redirectUris ?? [],
              postLogoutRedirectUris: body?.postLogoutRedirectUris ?? [],
              scopeWhitelist: body?.scopeWhitelist ?? ["openid"],
              rejectionReason: null,
            },
          }),
          clientSecret:
            body?.clientType === "web"
              ? "new-client-secret-plaintext"
              : undefined,
        };
      } else if (path.endsWith("/revision/submit") && method === "POST") {
        responseBody = {};
      } else if (path.includes("/clients/") && method === "GET") {
        responseBody = {
          client: (options.clients ?? [client()])[0],
        };
      } else if (path.includes("/secrets/rotate") && method === "POST") {
        responseBody = {
          secret: { value: "rotated-secret-plaintext" },
        };
      } else if (path.includes("/secrets/") && method === "POST") {
        responseBody = { client: client() };
      } else if (path.includes("/authorizations/revoke") && method === "POST") {
        responseBody = { client: client() };
      } else if (path.includes("/disable") && method === "POST") {
        responseBody = { client: client({ lifecycleStatus: "disabled" }) };
      } else if (path.endsWith("/admin/reviews") && method === "GET") {
        responseBody = {
          clients: [
            client({
              proposedRevision: {
                revisionId: 2,
                revisionNumber: 2,
                status: "pending",
                version: 1,
                redirectUris: ["https://new-uri.com"],
                postLogoutRedirectUris: [],
                scopeWhitelist: ["openid"],
                rejectionReason: null,
              },
            }),
          ],
        };
      } else if (path.includes("/approve") && method === "POST") {
        responseBody = { client: client() };
      } else if (path.includes("/reject") && method === "POST") {
        responseBody = { client: client() };
      } else {
        responseBody = {};
      }

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

test("redirects to login when unauthenticated", async () => {
  apiAuthenticated = false;
  mockApi();
  window.history.pushState({}, "", "/manage/projects");
  render(<App />);
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "登录管理台" })).toBeTruthy();
  });
});

test("handles successful login and redirects to projects", async () => {
  apiAuthenticated = false;
  const calls = mockApi();
  window.history.pushState({}, "", "/manage/login");
  render(<App />);

  const accountInput = await screen.findByPlaceholderText("学号/工号");
  const passwordInput = screen.getByPlaceholderText("密码");
  const submitButton = screen.getByRole("button", { name: "登录管理台" });

  fireEvent.change(accountInput, { target: { value: "admin" } });
  fireEvent.change(passwordInput, { target: { value: "password" } });

  // Set auth state to true before submitting the form
  apiAuthenticated = true;
  fireEvent.click(submitButton);

  await waitFor(() => {
    expect(
      calls.some(
        (call) => call.path.endsWith("/auth/login") && call.method === "POST",
      ),
    ).toBe(true);
  });
});

test("shows project list and handles switching", async () => {
  mockApi({
    projects: [
      project({ projectId: "p1", name: "Project One" }),
      project({ projectId: "p2", name: "Project Two" }),
    ],
  });
  window.history.pushState({}, "", "/manage/projects");
  render(<App />);

  // Should render active project Sider details
  expect(await screen.findByText("当前项目【Project One】")).toBeTruthy();
  // Should render projects table with unique link roles
  expect((await screen.findAllByText("Project One")).length).toBeGreaterThan(0);
  expect(await screen.findByText("Project Two")).toBeTruthy();
});

test("shows clients returned by the current project list", async () => {
  mockApi();
  window.history.pushState({}, "", "/manage/projects/project_one/clients");
  render(<App />);

  expect(await screen.findByText("Active Web")).toBeTruthy();
});

test("keeps the client danger zone open", async () => {
  mockApi();
  window.history.pushState(
    {},
    "",
    "/manage/projects/project_one/clients/active-web/overview",
  );
  render(<App />);

  fireEvent.click(
    await screen.findByRole("tab", { name: "安全操作 (Danger Zone)" }),
  );

  expect(await screen.findByText("危险操作区")).toBeTruthy();
  expect(window.location.pathname).toBe(
    "/manage/projects/project_one/clients/active-web/safety",
  );
});

test("opens the OIDC configuration editor", async () => {
  mockApi();
  window.history.pushState(
    {},
    "",
    "/manage/projects/project_one/clients/active-web/configuration",
  );
  render(<App />);

  fireEvent.click(
    await screen.findByRole("button", { name: "修改 OIDC 配置" }),
  );

  expect(await screen.findByText("编辑 OIDC 变更配置")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /添加 Redirect URI/ }),
  ).toBeTruthy();
});

test("shows project names and descriptions in pending reviews", async () => {
  mockApi({ isAdmin: true });
  window.history.pushState({}, "", "/manage/admin/reviews");
  render(<App />);

  expect(
    await screen.findByRole("columnheader", { name: "项目" }),
  ).toBeTruthy();
  expect((await screen.findAllByText("Project One")).length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "对比并审核" }));

  expect(await screen.findByText("申请描述")).toBeTruthy();
  expect(screen.getByText("Production client")).toBeTruthy();
});

test("creates the selected web client type", async () => {
  const calls = mockApi();
  window.history.pushState({}, "", "/manage/projects/project_one/clients/new");
  render(<App />);

  fireEvent.change(await screen.findByLabelText("显示名称"), {
    target: { value: "Web Client" },
  });
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));

  fireEvent.click(await screen.findByRole("radio", { name: /^Web/ }));
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));

  fireEvent.change(
    await screen.findByPlaceholderText("https://example.com/callback"),
    { target: { value: "https://client.example.com/callback" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  fireEvent.click(await screen.findByRole("button", { name: "下一步" }));

  expect(await screen.findByText("Web (保密客户端)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "创建并提交草稿" }));

  await waitFor(() => {
    expect(
      calls.find(
        (call) => call.path.endsWith("/clients") && call.method === "POST",
      )?.body.clientType,
    ).toBe("web");
  });

  expect(
    calls.find(
      (call) =>
        call.path.endsWith("/revision/submit") && call.method === "POST",
    )?.body,
  ).toEqual({ revisionId: 2, revisionVersion: 1 });

  fireEvent.click(await screen.findByRole("button", { name: "我已安全保存" }));
  expect(await screen.findByText("Active Web")).toBeTruthy();
});

test("hides the system project and exposes its clients to admins", async () => {
  mockApi({
    isAdmin: true,
    projects: [
      project({ projectId: "system", name: "System", role: null }),
      project({ projectId: "p1", name: "Project One" }),
    ],
  });
  window.history.pushState({}, "", "/manage/projects");
  render(<App />);

  expect(await screen.findByText("系统客户端")).toBeTruthy();
  expect(screen.queryByText("[系统项目]")).toBeNull();
  expect(screen.queryByRole("link", { name: "System" })).toBeNull();

  fireEvent.click(screen.getByText("系统客户端"));
  await waitFor(() => {
    expect(window.location.pathname).toBe("/manage/projects/system/overview");
  });
  expect(screen.getByText("当前项目【系统客户端】")).toBeTruthy();
  expect(screen.getAllByText("项目概览").length).toBeGreaterThan(0);
  expect(screen.getByText("审计日志")).toBeTruthy();
  expect(screen.queryByText("OIDC 客户端")).toBeNull();
  expect(screen.queryByText("当前项目【Project One】")).toBeNull();
  expect(screen.queryByRole("button", { name: "创建客户端" })).toBeNull();
});
