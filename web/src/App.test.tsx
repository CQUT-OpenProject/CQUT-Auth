import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "./App";

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
