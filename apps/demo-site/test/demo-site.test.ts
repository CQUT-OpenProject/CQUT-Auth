import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import request from "supertest";
import { createDemoApp } from "../src/app.js";

function jsonResponse(
  body: Record<string, unknown>,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

test("GET /demo serves the demo page shell", async () => {
  const app = createDemoApp();
  const response = await request(app).get("/demo");

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-security-policy"]?.includes("script-src 'self'"), true);
  assert.match(response.text, /id="verify-form"/);
  assert.match(response.text, /\/demo\/assets\/style\.css/);
  assert.match(response.text, /Raw JSON/);
});

test("POST /demo/api/verify forwards account and password with server credentials", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const app = createDemoApp({
    authServiceBaseUrl: "http://auth-service:3001",
    clientId: "site_demo",
    clientSecret: "demo-secret",
    fetchImpl: async (url, init) => {
      calls.push(init === undefined ? { url: String(url) } : { url: String(url), init });
      return jsonResponse(
        {
          request_id: "req_123",
          status: "pending",
          expires_at: "2026-04-01T10:00:00.000Z"
        },
        { status: 202 }
      );
    }
  });

  const response = await request(app).post("/demo/api/verify").send({
    account: "20240001",
    password: "mock-password"
  });

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  const firstCall = calls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.url, "http://auth-service:3001/verify");
  assert.equal(
    (firstCall.init?.headers as Record<string, string>)["Authorization"],
    `Basic ${Buffer.from("site_demo:demo-secret").toString("base64")}`
  );
  assert.deepEqual(JSON.parse(String(firstCall.init?.body)), {
    account: "20240001",
    password: "mock-password",
    scope: ["student.verify"]
  });
});

test("POST /demo/api/verify uses CLIENT_ID and CLIENT_SECRET from env", async () => {
  const previousClientId = process.env["CLIENT_ID"];
  const previousClientSecret = process.env["CLIENT_SECRET"];
  try {
    process.env["CLIENT_ID"] = "env_demo";
    process.env["CLIENT_SECRET"] = "env-secret";

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const app = createDemoApp({
      authServiceBaseUrl: "http://auth-service:3001",
      fetchImpl: async (url, init) => {
        calls.push(init === undefined ? { url: String(url) } : { url: String(url), init });
        return jsonResponse(
          {
            request_id: "req_env",
            status: "pending",
            expires_at: "2026-04-01T10:00:00.000Z"
          },
          { status: 202 }
        );
      }
    });

    const response = await request(app).post("/demo/api/verify").send({
      account: "20240001",
      password: "mock-password"
    });

    assert.equal(response.status, 202);
    assert.equal(
      (calls[0]?.init?.headers as Record<string, string>)["Authorization"],
      `Basic ${Buffer.from("env_demo:env-secret").toString("base64")}`
    );
  } finally {
    if (previousClientId === undefined) {
      delete process.env["CLIENT_ID"];
    } else {
      process.env["CLIENT_ID"] = previousClientId;
    }
    if (previousClientSecret === undefined) {
      delete process.env["CLIENT_SECRET"];
    } else {
      process.env["CLIENT_SECRET"] = previousClientSecret;
    }
  }
});

test("POST /demo/api/verify includes student.dedupe when toggle is enabled", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const app = createDemoApp({
    authServiceBaseUrl: "http://auth-service:3001",
    clientId: "site_demo",
    clientSecret: "demo-secret",
    fetchImpl: async (url, init) => {
      calls.push(init === undefined ? { url: String(url) } : { url: String(url), init });
      return jsonResponse(
        {
          request_id: "req_456",
          status: "pending",
          expires_at: "2026-04-01T10:00:00.000Z"
        },
        { status: 202 }
      );
    }
  });

  const response = await request(app).post("/demo/api/verify").send({
    account: "20240001",
    password: "mock-password",
    include_dedupe: true
  });

  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    account: "20240001",
    password: "mock-password",
    scope: ["student.verify", "student.dedupe"]
  });
});

test("GET /demo/api/result/:requestId relays result body and retry-after header", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const app = createDemoApp({
    authServiceBaseUrl: "http://auth-service:3001",
    clientId: "site_demo",
    clientSecret: "demo-secret",
    fetchImpl: async (url, init) => {
      calls.push(init === undefined ? { url: String(url) } : { url: String(url), init });
      return jsonResponse(
        {
          error: "rate_limited",
          error_description: "verification rate limit exceeded",
          retry_after_seconds: 52
        },
        {
          status: 429,
          headers: {
            "Retry-After": "52"
          }
        }
      );
    }
  });

  const response = await request(app).get("/demo/api/result/req_123");

  assert.equal(response.status, 429);
  assert.equal(response.headers["retry-after"], "52");
  assert.equal(response.body.error, "rate_limited");
  assert.equal(calls[0]?.url, "http://auth-service:3001/result/req_123");
  assert.equal(
    ((calls[0]?.init?.headers ?? {}) as Record<string, string>)["Authorization"],
    `Basic ${Buffer.from("site_demo:demo-secret").toString("base64")}`
  );
});

test("demo api returns 502 when auth service is unreachable", async () => {
  const app = createDemoApp({
    clientSecret: "demo-secret",
    fetchImpl: async () => {
      throw new Error("unreachable");
    }
  });

  const response = await request(app).post("/demo/api/verify").send({
    account: "20240001",
    password: "mock-password"
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.error, "upstream_unavailable");
});

test("demo api returns 503 when demo client is disabled", async () => {
  process.env["DEMO_CLIENT_ENABLED"] = "false";
  const app = createDemoApp();
  const response = await request(app).post("/demo/api/verify").send({
    account: "20240001",
    password: "mock-password"
  });
  delete process.env["DEMO_CLIENT_ENABLED"];

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "server_error");
});

test("demo-site requires explicit demo client enablement in production", async () => {
  process.env["APP_ENV"] = "production";
  delete process.env["DEMO_CLIENT_ENABLED"];
  assert.throws(() => createDemoApp(), /DEMO_CLIENT_ENABLED must be true/);
  delete process.env["APP_ENV"];
});

test("browser flow auto polls and renders succeeded state", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/assets/app.js", import.meta.url), "utf8");
  const responses = [
    jsonResponse(
      {
        request_id: "req_demo",
        status: "pending",
        expires_at: "2026-04-01T10:00:00.000Z"
      },
      { status: 201 }
    ),
    jsonResponse(
      {
        request_id: "req_demo",
        status: "running",
        expires_at: "2026-04-01T10:00:00.000Z"
      },
      { status: 200 }
    ),
    jsonResponse(
      {
        request_id: "req_demo",
        status: "succeeded",
        verified: true,
        student_status: "active_student",
        school: "cqut",
        completed_at: "2026-04-01T10:00:02.000Z"
      },
      { status: 200 }
    )
  ];

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/demo"
  });
  const { window } = dom;
  Object.defineProperty(window, "__CQUT_DEMO_CONFIG__", {
    configurable: true,
    value: {
      pollIntervalMs: 5
    }
  });
  window.fetch = async () => {
    const next = responses.shift();
    assert.ok(next, "unexpected fetch");
    return next;
  };
  window.eval(script);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  (window.document.getElementById("account-input") as HTMLInputElement).value = "20240001";
  (window.document.getElementById("password-input") as HTMLInputElement).value = "mock-password";
  window.document.getElementById("verify-form")!.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true })
  );

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(window.document.getElementById("state-badge")!.textContent, "SUCCEEDED");
  assert.match(window.document.getElementById("raw-response")!.textContent, /"status": "succeeded"/);
  assert.equal(window.document.getElementById("student-status")!.textContent, "active_student");
  dom.window.close();
});

test("browser flow sends dedupe toggle and renders dedupe_key", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/assets/app.js", import.meta.url), "utf8");
  const requestBodies: string[] = [];
  const responses = [
    jsonResponse(
      {
        request_id: "req_demo",
        status: "pending",
        expires_at: "2026-04-01T10:00:00.000Z"
      },
      { status: 202 }
    ),
    jsonResponse(
      {
        request_id: "req_demo",
        status: "succeeded",
        verified: true,
        student_status: "active_student",
        school: "cqut",
        dedupe_key: "ddk_demo_value",
        completed_at: "2026-04-01T10:00:02.000Z"
      },
      { status: 200 }
    )
  ];

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/demo"
  });
  const { window } = dom;
  Object.defineProperty(window, "__CQUT_DEMO_CONFIG__", {
    configurable: true,
    value: {
      pollIntervalMs: 5
    }
  });
  window.fetch = async (_url, init) => {
    if (init?.body) {
      requestBodies.push(String(init.body));
    }
    const next = responses.shift();
    assert.ok(next, "unexpected fetch");
    return next;
  };
  window.eval(script);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  (window.document.getElementById("account-input") as HTMLInputElement).value = "20240001";
  (window.document.getElementById("password-input") as HTMLInputElement).value = "mock-password";
  (window.document.getElementById("dedupe-toggle") as HTMLInputElement).checked = true;
  window.document.getElementById("verify-form")!.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true })
  );

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.match(requestBodies[0] ?? "", /"include_dedupe":true/);
  assert.equal(window.document.getElementById("dedupe-key")!.textContent, "ddk_demo_value");
  dom.window.close();
});

test("browser flow renders rate_limited response on submit", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/assets/app.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/demo"
  });
  const { window } = dom;
  window.fetch = async () =>
    jsonResponse(
      {
        error: "rate_limited",
        error_description: "verification rate limit exceeded",
        retry_after_seconds: 60
      },
      {
        status: 429,
        headers: {
          "Retry-After": "60"
        }
      }
    );
  window.eval(script);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  (window.document.getElementById("account-input") as HTMLInputElement).value = "20240001";
  (window.document.getElementById("password-input") as HTMLInputElement).value = "mock-password";
  window.document.getElementById("verify-form")!.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(window.document.getElementById("state-badge")!.textContent, "RATE_LIMITED");
  assert.match(window.document.getElementById("state-detail")!.textContent, /rate limit/i);
  assert.equal(window.document.getElementById("retry-after")!.textContent, "60");
  dom.window.close();
});
