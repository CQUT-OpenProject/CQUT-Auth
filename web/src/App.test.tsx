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

test("shows the management login when the session is anonymous", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ authenticated: false, csrfToken: "csrf" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "客户端管理" })).toBeTruthy(),
  );
  expect(screen.getByLabelText("账号")).toBeTruthy();
  expect(screen.getByText(/密码仅用于本次认证/)).toBeTruthy();
});

test("keeps active client type and sensitive settings read-only", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const body = path.endsWith("/auth/context")
        ? {
            authenticated: true,
            csrfToken: "csrf",
            user: {
              subjectId: "subj_owner",
              displayName: "Owner",
              isAdmin: false,
            },
          }
        : {
            clients: [
              {
                clientId: "active-web",
                displayName: "Active Web",
                description: "Production client",
                clientType: "web",
                redirectUris: ["https://app.example.com/callback"],
                postLogoutRedirectUris: [],
                scopeWhitelist: ["openid", "profile"],
                status: "active",
                rejectionReason: null,
                updatedAt: "2026-07-13T00:00:00.000Z",
                version: 2,
              },
            ],
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(
    (screen.getByLabelText("客户端类型") as HTMLSelectElement).disabled,
  ).toBe(true);
  expect((screen.getByLabelText("显示名称") as HTMLInputElement).disabled).toBe(
    false,
  );
  expect(
    (screen.getByLabelText(/Redirect URI（每行一个）/) as HTMLTextAreaElement)
      .disabled,
  ).toBe(true);
});
