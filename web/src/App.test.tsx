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

const activeRevision = {
  revisionId: 1,
  revisionNumber: 1,
  status: "approved",
  version: 2,
  redirectUris: ["https://app.example.com/callback"],
  postLogoutRedirectUris: [],
  scopeWhitelist: ["openid", "profile"],
  rejectionReason: null,
};

function client(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "active-web",
    displayName: "Active Web",
    description: "Production client",
    clientType: "web",
    lifecycleStatus: "active",
    activeRevision,
    proposedRevision: null,
    updatedAt: "2026-07-13T00:00:00.000Z",
    clientVersion: 2,
    secrets: [
      {
        secretId: "secret_current",
        status: "active",
        createdAt: "2026-07-13T00:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
        version: 1,
      },
    ],
    ...overrides,
  };
}

function mockApi(value: ReturnType<typeof client>, isAdmin = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.endsWith("/auth/context")
        ? {
            authenticated: true,
            csrfToken: "csrf",
            clientSecretPolicy: {
              defaultGraceSeconds: 3_600,
              maxGraceSeconds: 7_200,
            },
            user: { subjectId: "subj_owner", displayName: "Owner", isAdmin },
          }
        : { clients: [value] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

test("shows active configuration and warns that sensitive edits require approval", async () => {
  mockApi(client());
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(screen.getByText("当前生效配置")).toBeTruthy();
  expect(screen.getByText(/审核通过后生效/)).toBeTruthy();
  expect(
    (screen.getByLabelText("客户端类型") as HTMLSelectElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText(/Redirect URI（每行一个）/) as HTMLTextAreaElement)
      .disabled,
  ).toBe(false);
  expect(screen.getByRole("button", { name: "保存基本信息" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "保存并提交敏感修改" }),
  ).toBeTruthy();
});

test("saves metadata and OIDC configuration through separate operations", async () => {
  const calls: Array<{ path: string; method: string }> = [];
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
              defaultGraceSeconds: 3_600,
              maxGraceSeconds: 7_200,
            },
            user: {
              subjectId: "subj_owner",
              displayName: "Owner",
              isAdmin: false,
            },
          }
        : path.endsWith("/clients") && method === "GET"
          ? { clients: [client()] }
          : { client: client() };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  fireEvent.change(screen.getByLabelText("显示名称"), {
    target: { value: "Renamed Client" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存基本信息" }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === "PATCH")).toBe(true),
  );
  expect(calls.some((call) => call.method === "PUT")).toBe(false);

  fireEvent.change(screen.getByLabelText(/Redirect URI（每行一个）/), {
    target: { value: "https://app.example.com/new-callback" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存并提交敏感修改" }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === "PUT")).toBe(true),
  );
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
});

test("labels client creation as creating a draft", async () => {
  mockApi(client());
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "创建客户端" }));
  expect(screen.getByRole("button", { name: "创建草稿" })).toBeTruthy();
});

test("shows secret lifecycle and confirms rotation and authorization revocation", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(path);
      const body = path.endsWith("/auth/context")
        ? {
            authenticated: true,
            csrfToken: "csrf",
            clientSecretPolicy: {
              defaultGraceSeconds: 3_600,
              maxGraceSeconds: 7_200,
            },
            user: {
              subjectId: "subj_owner",
              displayName: "Owner",
              isAdmin: false,
            },
          }
        : path.endsWith("/secrets/rotate") && init?.method === "POST"
          ? { secret: { value: "one-time-rotated-secret" } }
          : path.endsWith("/clients")
            ? { clients: [client()] }
            : { client: client() };
      return new Response(JSON.stringify(body), {
        status: path.endsWith("/secrets/rotate") ? 201 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(screen.getByText("secret_current")).toBeTruthy();
  expect(screen.getByText("当前生效")).toBeTruthy();
  const graceInput = screen.getByLabelText(
    "旧 Secret 宽限期（小时）",
  ) as HTMLInputElement;
  expect(graceInput.value).toBe("1");
  expect(graceInput.max).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "轮换 Secret" }));
  expect(await screen.findByText("one-time-rotated-secret")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销全部授权" }));
  await waitFor(() =>
    expect(calls.some((path) => path.endsWith("/authorizations/revoke"))).toBe(
      true,
    ),
  );
  expect(vi.mocked(confirm).mock.calls.length).toBeGreaterThanOrEqual(2);
});

test("paginates secret history in the management view", async () => {
  mockApi(
    client({
      secrets: Array.from({ length: 11 }, (_, index) => ({
        secretId: `secret_${index + 1}`,
        status: "revoked",
        createdAt: "2026-07-13T00:00:00.000Z",
        expiresAt: null,
        revokedAt: "2026-07-13T01:00:00.000Z",
        version: 2,
      })),
    }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(screen.getByText("secret_1")).toBeTruthy();
  expect(screen.queryByText("secret_11")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("secret_11")).toBeTruthy();
  expect(screen.queryByText("secret_1")).toBeNull();
});

test("freezes pending revision and shows field differences", async () => {
  mockApi(
    client({
      proposedRevision: {
        revisionId: 2,
        revisionNumber: 2,
        status: "pending",
        version: 1,
        redirectUris: ["https://app.example.com/new-callback"],
        postLogoutRedirectUris: [],
        scopeWhitelist: ["openid", "profile", "email"],
        rejectionReason: null,
      },
    }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(
    screen.getByText("+ https://app.example.com/new-callback"),
  ).toBeTruthy();
  expect(screen.getByText("- https://app.example.com/callback")).toBeTruthy();
  expect(screen.getByRole("button", { name: "撤回审核" })).toBeTruthy();
  expect(
    (screen.getByLabelText(/Redirect URI（每行一个）/) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
});

test("shows rejection reason and allows creating a new draft", async () => {
  mockApi(
    client({
      proposedRevision: {
        revisionId: 2,
        revisionNumber: 2,
        status: "rejected",
        version: 2,
        redirectUris: ["https://app.example.com/new-callback"],
        postLogoutRedirectUris: [],
        scopeWhitelist: ["openid"],
        rejectionReason: "callback ownership is unclear",
      },
    }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(
    screen.getAllByText(/callback ownership is unclear/).length,
  ).toBeGreaterThan(0);
  expect(
    (screen.getByLabelText(/Redirect URI（每行一个）/) as HTMLTextAreaElement)
      .disabled,
  ).toBe(false);
});

test("keeps the current client view when an older request finishes last", async () => {
  let resolveMine: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/auth/context"))
        return new Response(
          JSON.stringify({
            authenticated: true,
            csrfToken: "csrf",
            clientSecretPolicy: {
              defaultGraceSeconds: 3_600,
              maxGraceSeconds: 7_200,
            },
            user: {
              subjectId: "subj_admin",
              displayName: "Admin",
              isAdmin: true,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      if (path.endsWith("/clients"))
        return new Promise<Response>((resolve) => {
          resolveMine = resolve;
        });
      return new Response(
        JSON.stringify({
          clients: [
            client({ clientId: "all-client", displayName: "All Client" }),
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  render(<App />);
  await waitFor(() => expect(resolveMine).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "全部客户端" }));
  expect(await screen.findByText("All Client")).toBeTruthy();
  resolveMine!(
    new Response(
      JSON.stringify({
        clients: [
          client({ clientId: "mine-client", displayName: "Mine Client" }),
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  await waitFor(() => expect(screen.queryByText("Mine Client")).toBeNull());
});
