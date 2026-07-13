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
