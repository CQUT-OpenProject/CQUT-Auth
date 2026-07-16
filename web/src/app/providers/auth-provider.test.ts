import { expect, test, vi } from "vitest";

vi.mock("../../api/client", () => ({
  request: vi.fn(),
  setCsrfToken: vi.fn(),
}));

import { request, setCsrfToken } from "../../api/client";
import { authProvider } from "./auth-provider";

test("refreshes the anonymous CSRF context before submitting a login", async () => {
  const context = { authenticated: false as const, csrfToken: "fresh-csrf" };
  const authenticated = {
    authenticated: true as const,
    csrfToken: "session-csrf",
    user: {
      subjectId: "subj_test",
      preferredUsername: "test",
      displayName: "Test",
      isAdmin: false,
    },
    clientSecretPolicy: { defaultGraceSeconds: 3600, maxGraceSeconds: 7200 },
  };
  vi.mocked(request)
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce(authenticated);

  const result = await authProvider.login?.({
    account: "account",
    password: "password",
  });

  expect(result).toMatchObject({ success: true, redirectTo: "/projects" });
  expect(request).toHaveBeenNthCalledWith(1, "/auth/context");
  expect(setCsrfToken).toHaveBeenNthCalledWith(1, "fresh-csrf");
  expect(request).toHaveBeenNthCalledWith(2, "/auth/login", {
    method: "POST",
    body: JSON.stringify({ account: "account", password: "password" }),
  });
});
