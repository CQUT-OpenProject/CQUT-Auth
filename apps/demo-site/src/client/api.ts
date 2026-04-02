import type { DemoResponsePayload } from "./types.js";

export type JsonResult = {
  ok: boolean;
  status: number;
  retryAfter: string | null;
  body: DemoResponsePayload | Record<string, unknown>;
};

export async function requestJson(
  fetchImpl: typeof window.fetch,
  url: string,
  init?: RequestInit
): Promise<JsonResult> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body: DemoResponsePayload | Record<string, unknown> = {};

  if (text) {
    try {
      body = JSON.parse(text) as DemoResponsePayload;
    } catch {
      body = {
        error: "server_error",
        error_description: "demo page failed to parse response"
      };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
    body
  };
}
