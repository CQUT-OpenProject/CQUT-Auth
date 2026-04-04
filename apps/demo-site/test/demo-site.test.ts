import assert from "node:assert/strict";
import test from "node:test";
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

test("GET /demo renders sign-in page before authentication", async () => {
  const app = createDemoApp({
    fetchImpl: async () =>
      jsonResponse({
        authorization_endpoint: "http://localhost:3003/auth",
        token_endpoint: "http://localhost:3003/token",
        userinfo_endpoint: "http://localhost:3003/userinfo",
        end_session_endpoint: "http://localhost:3003/session/end"
      })
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
  const app = createDemoApp({
    oidcIssuer: "http://localhost:3003",
    demoBaseUrl: "http://localhost:3002",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({
        authorization_endpoint: "http://localhost:3003/auth",
        token_endpoint: "http://localhost:3003/token",
        userinfo_endpoint: "http://localhost:3003/userinfo",
        end_session_endpoint: "http://localhost:3003/session/end"
      });
    }
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
    createDemoApp({
      oidcIssuer: "http://localhost:3003",
      demoBaseUrl: "http://localhost:3002",
      fetchImpl: async (url, init) => {
        const target = String(url);
        if (target.endsWith("/.well-known/openid-configuration")) {
          return jsonResponse({
            authorization_endpoint: "http://localhost:3003/auth",
            token_endpoint: "http://localhost:3003/token",
            userinfo_endpoint: "http://localhost:3003/userinfo",
            end_session_endpoint: "http://localhost:3003/session/end"
          });
        }
        if (target.endsWith("/token")) {
          assert.equal(init?.method, "POST");
          const headers = init?.headers as Record<string, string>;
          assert.match(headers["Authorization"] as string, /^Basic /);
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
      }
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
    createDemoApp({
      oidcIssuer: "http://localhost:3003",
      demoBaseUrl: "http://localhost:3002",
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.endsWith("/.well-known/openid-configuration")) {
          return jsonResponse({
            authorization_endpoint: "http://localhost:3003/auth",
            token_endpoint: "http://localhost:3003/token",
            userinfo_endpoint: "http://localhost:3003/userinfo",
            end_session_endpoint: "http://localhost:3003/session/end"
          });
        }
        if (target.endsWith("/token")) {
          return jsonResponse({
            access_token: "access-token",
            id_token: "id-token"
          });
        }
        if (target.endsWith("/userinfo")) {
          return jsonResponse({
            sub: "subj_demo"
          });
        }
        throw new Error(`unexpected fetch target: ${target}`);
      }
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
  assert.equal(logoutUrl.searchParams.get("post_logout_redirect_uri"), "http://localhost:3002/demo");

  const page = await agent.get("/demo");
  assert.match(page.text, /data-state="[^"]*%22kind%22%3A%22guest%22/);
});
