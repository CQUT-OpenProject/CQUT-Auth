import { beforeEach, expect, test, vi } from "vitest";
import { getCsrfToken, request, setCsrfToken } from "./client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  setCsrfToken(undefined);
  vi.restoreAllMocks();
});

test("refreshes a missing CSRF token before a mutation", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      jsonResponse({ authenticated: true, csrfToken: "fresh-token" }),
    )
    .mockResolvedValueOnce(jsonResponse({ saved: true }));

  await expect(
    request("/settings/runtime-policy", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 1 }),
    }),
  ).resolves.toEqual({ saved: true });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/management/auth/context");
  const mutationHeaders = new Headers(
    (fetchMock.mock.calls[1]?.[1] as RequestInit).headers,
  );
  expect(mutationHeaders.get("X-CSRF-Token")).toBe("fresh-token");
});

test("refreshes a CSRF token before it expires", async () => {
  const expiresSoon = Math.floor(Date.now() / 1000) + 10;
  setCsrfToken(`${expiresSoon}.binding.signature`);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      jsonResponse({ authenticated: true, csrfToken: "renewed-token" }),
    )
    .mockResolvedValueOnce(jsonResponse({ saved: true }));

  await request("/projects", { method: "POST", body: "{}" });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(getCsrfToken()).toBe("renewed-token");
});

test("refreshes and retries once after an explicit CSRF rejection", async () => {
  const future = Math.floor(Date.now() / 1000) + 300;
  setCsrfToken(`${future}.binding.stale-signature`);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      jsonResponse(
        {
          error: "invalid_request",
          error_description: "CSRF validation failed",
        },
        400,
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse({ authenticated: true, csrfToken: "replacement-token" }),
    )
    .mockResolvedValueOnce(jsonResponse({ saved: true }));
  const options = { method: "PUT", body: JSON.stringify({ value: 1 }) };

  await expect(request("/settings/runtime-policy", options)).resolves.toEqual({
    saved: true,
  });

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ body: options.body });
  const retryHeaders = new Headers(
    (fetchMock.mock.calls[2]?.[1] as RequestInit).headers,
  );
  expect(retryHeaders.get("X-CSRF-Token")).toBe("replacement-token");
});

test("does not retry unrelated invalid requests", async () => {
  const future = Math.floor(Date.now() / 1000) + 300;
  setCsrfToken(`${future}.binding.signature`);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    jsonResponse(
      {
        error: "invalid_request",
        error_description: "invalid runtime policy",
      },
      400,
    ),
  );

  await expect(
    request("/settings/runtime-policy", { method: "PUT" }),
  ).rejects.toEqual(
    expect.objectContaining({
      status: 400,
      code: "invalid_request",
      message: "invalid runtime policy",
    }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
