import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createDemoApp } from "../src/app.js";
import type { DemoSession, DemoSessionStore } from "../src/session-store.js";

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

function createMemorySessionStore(sharedSessions = new Map<string, DemoSession>()) {
  const store: DemoSessionStore = {
    async ping() {},
    async get(sessionId: string) {
      const session = sharedSessions.get(sessionId);
      return session ? (JSON.parse(JSON.stringify(session)) as DemoSession) : null;
    },
    async set(session: DemoSession) {
      sharedSessions.set(session.sessionId, JSON.parse(JSON.stringify(session)) as DemoSession);
    },
    async destroy(sessionId: string) {
      sharedSessions.delete(sessionId);
    }
  };
  return { store, sharedSessions };
}

function parseCookieValue(setCookie: string | undefined, name: string) {
  if (!setCookie) {
    return undefined;
  }
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1];
}

function resolveTarget(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function makeFetchStub(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = resolveTarget(input);
    if (target.endsWith("/.well-known/openid-configuration")) {
      return jsonResponse({
        authorization_endpoint: "http://localhost:3003/auth",
        token_endpoint: "http://localhost:3003/token",
        userinfo_endpoint: "http://localhost:3003/userinfo",
        end_session_endpoint: "http://localhost:3003/session/end"
      });
    }
    if (target.endsWith("/token")) {
      if (init) {
        assert.equal(init.method, "POST");
      }
      return jsonResponse({
        access_token: "access-token",
        id_token: "id-token",
        token_type: "Bearer",
        expires_in: 300
      });
    }
    if (target.endsWith("/userinfo")) {
      return jsonResponse({
        sub: "subj_demo",
        preferred_username: "20240001",
        name: "CQUT User 20240001",
        email: "demo@example.com",
        email_verified: false,
        school: "cqut",
        student_status: "active_student"
      });
    }
    throw new Error(`unexpected fetch target: ${target}`);
  };
}

test("startup fails when REDIS_URL is missing and no sessionStore override is provided", async () => {
  await assert.rejects(
    () =>
      createDemoApp({
        fetchImpl: makeFetchStub()
      }),
    /REDIS_URL is required/
  );
});

test("GET /demo renders sign-in page before authentication", async () => {
  const app = await createDemoApp({
    fetchImpl: makeFetchStub(),
    sessionStore: createMemorySessionStore().store
  });
  const response = await request(app).get("/demo");

  assert.equal(response.status, 200);
  assert.match(response.text, /id="root"/);
  assert.match(response.text, /\/demo\/assets\/app\.js/);
  assert.match(response.text, /data-state="[^"]*%22kind%22%3A%22guest%22/);
  assert.match(response.text, /data-state="[^"]*%22loginUrl%22%3A%22%2Fdemo%2Flogin%22/);
});

test("GET /demo/login redirects to authorization endpoint with PKCE parameters", async () => {
  const calls: string[] = [];
  const app = await createDemoApp({
    oidcIssuer: "http://localhost:3003",
    demoBaseUrl: "http://localhost:3002",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return makeFetchStub()(url, undefined);
    },
    sessionStore: createMemorySessionStore().store
  });

  const response = await request(app).get("/demo/login");
  assert.equal(response.status, 302);
  assert.equal(calls[0], "http://localhost:3003/.well-known/openid-configuration");
  const redirect = new URL(response.headers["location"] as string, "http://localhost:3003");
  assert.equal(redirect.pathname, "/auth");
  assert.equal(redirect.searchParams.get("client_id"), "demo-site");
  assert.equal(redirect.searchParams.get("response_type"), "code");
  assert.equal(redirect.searchParams.get("prompt"), "consent");
  assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
  assert.equal(redirect.searchParams.get("redirect_uri"), "http://localhost:3002/demo/callback");
});

test("callback exchanges code, fetches userinfo, and renders authenticated session", async () => {
  const agent = request.agent(
    await createDemoApp({
      oidcIssuer: "http://localhost:3003",
      demoBaseUrl: "http://localhost:3002",
      fetchImpl: makeFetchStub(),
      sessionStore: createMemorySessionStore().store
    })
  );

  const login = await agent.get("/demo/login");
  assert.equal(login.status, 302);
  const redirect = new URL(login.headers["location"] as string, "http://localhost:3003");
  const state = redirect.searchParams.get("state") ?? "";
  assert.ok(state);

  const callback = await agent.get(`/demo/callback?code=code-123&state=${encodeURIComponent(state as string)}`);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers["location"], "/demo");

  const page = await agent.get("/demo");
  assert.equal(page.status, 200);
  assert.match(page.text, /data-state="[^"]*%22kind%22%3A%22authenticated%22/);
  assert.match(page.text, /CQUT%20User%2020240001/);
  assert.match(page.text, /demo%40example\.com/);
  assert.match(page.text, /student_status/);
});

test("logout clears local session and redirects to end_session_endpoint", async () => {
  const agent = request.agent(
    await createDemoApp({
      oidcIssuer: "http://localhost:3003",
      demoBaseUrl: "http://localhost:3002",
      fetchImpl: makeFetchStub(),
      sessionStore: createMemorySessionStore().store
    })
  );

  const login = await agent.get("/demo/login");
  const redirect = new URL(login.headers["location"] as string, "http://localhost:3003");
  const state = redirect.searchParams.get("state") ?? "";
  await agent.get(`/demo/callback?code=code-123&state=${encodeURIComponent(state as string)}`);

  const logout = await agent.get("/demo/logout");
  assert.equal(logout.status, 302);
  const logoutUrl = new URL(logout.headers["location"] as string, "http://localhost:3003");
  assert.equal(logoutUrl.pathname, "/session/end");
  assert.equal(logoutUrl.searchParams.get("post_logout_redirect_uri"), "http://localhost:3002/demo/logout-complete");

  const logoutComplete = await agent.get("/demo/logout-complete");
  assert.equal(logoutComplete.status, 200);
  assert.match(logoutComplete.text, /Signed Out/);

  const page = await agent.get("/demo");
  assert.match(page.text, /data-state="[^"]*%22kind%22%3A%22guest%22/);
});

test("session store does not persist accessToken after callback", async () => {
  const memory = createMemorySessionStore();
  const app = await createDemoApp({
    oidcIssuer: "http://localhost:3003",
    demoBaseUrl: "http://localhost:3002",
    fetchImpl: makeFetchStub(),
    sessionStore: memory.store
  });
  const agent = request.agent(app);

  const login = await agent.get("/demo/login");
  const state = new URL(login.headers["location"] as string, "http://localhost:3003").searchParams.get("state") ?? "";
  await agent.get(`/demo/callback?code=code-123&state=${encodeURIComponent(state)}`);

  const sid = parseCookieValue(login.headers["set-cookie"]?.[0], "demo_sid");
  assert.ok(sid);
  const persisted = memory.sharedSessions.get(sid as string);
  assert.ok(persisted);
  assert.equal(Object.hasOwn(persisted as object, "accessToken"), false);
});

test("multiple demo-site instances share authenticated session with shared session store", async () => {
  const sharedSessions = new Map<string, DemoSession>();
  const appA = await createDemoApp({
    oidcIssuer: "http://localhost:3003",
    demoBaseUrl: "http://localhost:3002",
    fetchImpl: makeFetchStub(),
    sessionStore: createMemorySessionStore(sharedSessions).store
  });
  const appB = await createDemoApp({
    oidcIssuer: "http://localhost:3003",
    demoBaseUrl: "http://localhost:3002",
    fetchImpl: makeFetchStub(),
    sessionStore: createMemorySessionStore(sharedSessions).store
  });

  const agentA = request.agent(appA);
  const login = await agentA.get("/demo/login");
  const state = new URL(login.headers["location"] as string, "http://localhost:3003").searchParams.get("state") ?? "";
  await agentA.get(`/demo/callback?code=code-123&state=${encodeURIComponent(state)}`);

  const setCookie = login.headers["set-cookie"]?.[0];
  assert.ok(setCookie);
  const cookie = setCookie.split(";")[0];
  const pageFromB = await request(appB).get("/demo").set("Cookie", cookie as string);
  assert.equal(pageFromB.status, 200);
  assert.match(pageFromB.text, /data-state="[^"]*%22kind%22%3A%22authenticated%22/);
});

test("session survives app restart when backed by shared store", async () => {
  const sharedSessions = new Map<string, DemoSession>();
  const app1 = await createDemoApp({
    oidcIssuer: "http://localhost:3003",
    demoBaseUrl: "http://localhost:3002",
    fetchImpl: makeFetchStub(),
    sessionStore: createMemorySessionStore(sharedSessions).store
  });

  const agent = request.agent(app1);
  const login = await agent.get("/demo/login");
  const state = new URL(login.headers["location"] as string, "http://localhost:3003").searchParams.get("state") ?? "";
  await agent.get(`/demo/callback?code=code-123&state=${encodeURIComponent(state)}`);
  const setCookie = login.headers["set-cookie"]?.[0];
  assert.ok(setCookie);
  const cookie = setCookie.split(";")[0];

  const app2 = await createDemoApp({
    oidcIssuer: "http://localhost:3003",
    demoBaseUrl: "http://localhost:3002",
    fetchImpl: makeFetchStub(),
    sessionStore: createMemorySessionStore(sharedSessions).store
  });
  const page = await request(app2).get("/demo").set("Cookie", cookie as string);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-state="[^"]*%22kind%22%3A%22authenticated%22/);
});
