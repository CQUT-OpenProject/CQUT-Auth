import { ApiError } from "./errors";

let csrfToken: string | undefined;
let csrfRefreshPromise: Promise<void> | undefined;

const managementApiBase = "/api/management";
const csrfRefreshWindowSeconds = 30;

export function setCsrfToken(token: string | undefined) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

function isMutation(options: RequestInit) {
  const method = (options.method ?? "GET").toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function csrfTokenNeedsRefresh(token: string | undefined) {
  if (!token) return true;
  const expires = Number(token.split(".", 1)[0]);
  return (
    !Number.isInteger(expires) ||
    expires <= Math.floor(Date.now() / 1000) + csrfRefreshWindowSeconds
  );
}

function isCsrfValidationError(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    error.code === "invalid_request" &&
    error.message === "CSRF validation failed"
  );
}

async function executeRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  const response = await fetch(`${managementApiBase}${path}`, {
    ...options,
    headers,
  });

  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfter = retryAfterHeader
    ? parseInt(retryAfterHeader, 10)
    : undefined;

  if (!response.ok) {
    let body: any = {};
    try {
      body = await response.json();
    } catch {
      // Empty or non-JSON error response
    }
    throw new ApiError(
      response.status,
      body.error ?? "request_failed",
      body.error_description ?? "请求失败，请稍后重试。",
      body.field_errors,
      retryAfter,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function refreshCsrfContext() {
  if (!csrfRefreshPromise) {
    csrfRefreshPromise = (async () => {
      const context = await executeRequest<{ csrfToken?: unknown }>(
        "/auth/context",
      );
      if (typeof context.csrfToken !== "string" || !context.csrfToken) {
        throw new ApiError(
          500,
          "invalid_auth_context",
          "认证上下文未返回 CSRF Token。",
        );
      }
      setCsrfToken(context.csrfToken);
    })().finally(() => {
      csrfRefreshPromise = undefined;
    });
  }
  await csrfRefreshPromise;
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const canRefresh = path !== "/auth/context";
  if (canRefresh && isMutation(options) && csrfTokenNeedsRefresh(csrfToken)) {
    await refreshCsrfContext();
  }

  try {
    return await executeRequest<T>(path, options);
  } catch (error) {
    if (!canRefresh || !isCsrfValidationError(error)) {
      throw error;
    }
    await refreshCsrfContext();
    return executeRequest<T>(path, options);
  }
}
