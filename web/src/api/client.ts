import { ApiError } from "./errors";

let csrfToken: string | undefined;

export function setCsrfToken(token: string | undefined) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

export async function request<T>(
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

  const response = await fetch(`/api/management${path}`, {
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
