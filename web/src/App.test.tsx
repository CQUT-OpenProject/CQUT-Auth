import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
  options: { projects?: ReturnType<typeof project>[]; isAdmin?: boolean } = {},
) {
  const calls: Array<{ path: string; method: string }> = [];
  const projects = options.projects ?? [project()];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      const body = path.endsWith("/auth/context")
        ? {
            authenticated: true,
            csrfToken: "csrf",
            clientSecretPolicy: {
              defaultGraceSeconds: 3600,
              maxGraceSeconds: 7200,
            },
            user: {
              subjectId: "subj_owner",
              displayName: "Owner",
              isAdmin: !!options.isAdmin,
            },
          }
        : path.endsWith("/projects") && method === "GET"
          ? { projects }
          : path.endsWith("/members")
            ? {
                members: [
                  {
                    projectId: "project_one",
                    subjectId: "subj_owner",
                    role: "owner",
                    createdAt: "2026-07-13T00:00:00.000Z",
                    updatedAt: "2026-07-13T00:00:00.000Z",
                  },
                ],
              }
            : path.endsWith("/admin/reviews")
              ? { clients: [client()] }
              : path.includes("/clients") && method === "GET"
                ? {
                    clients: [
                      client({
                        projectId: path.includes("project_two")
                          ? "project_two"
                          : "project_one",
                      }),
                    ],
                  }
                : { project: projects[0], client: client() };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

test("shows project switcher, members, and project clients for owners", async () => {
  mockApi();
  render(<App />);
  expect(
    await screen.findByRole("button", { name: "Project One · owner" }),
  ).toBeTruthy();
  expect(await screen.findByText("subj_owner")).toBeTruthy();
  expect(await screen.findByText("Active Web")).toBeTruthy();
  expect(screen.getByRole("button", { name: "创建客户端" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "添加成员" })).toBeTruthy();
});

test("switches the client list to the selected project", async () => {
  const calls = mockApi({
    projects: [
      project(),
      project({ projectId: "project_two", name: "Project Two" }),
    ],
  });
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Project Two · owner" }),
  );
  await waitFor(() =>
    expect(
      calls.some((call) => call.path.endsWith("/projects/project_two/clients")),
    ).toBe(true),
  );
});

test("viewer receives a read-only project view", async () => {
  mockApi({ projects: [project({ role: "viewer", capabilities: ["view"] })] });
  render(<App />);
  expect(await screen.findByText("Active Web")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "创建客户端" })).toBeNull();
  expect(screen.queryByRole("button", { name: "添加成员" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
  expect(screen.queryByRole("button", { name: "保存基本信息" })).toBeNull();
});

test("member addition uses the project version and nested endpoint", async () => {
  const calls = mockApi();
  render(<App />);
  const input = await screen.findByLabelText("Subject ID");
  fireEvent.change(input, { target: { value: "subj_new" } });
  fireEvent.click(screen.getByRole("button", { name: "添加成员" }));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.path.endsWith("/projects/project_one/members") &&
          call.method === "POST",
      ),
    ).toBe(true),
  );
});

test("administrators can open the global review view", async () => {
  const calls = mockApi({ isAdmin: true });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "待审核" }));
  await waitFor(() =>
    expect(calls.some((call) => call.path.endsWith("/admin/reviews"))).toBe(
      true,
    ),
  );
});
