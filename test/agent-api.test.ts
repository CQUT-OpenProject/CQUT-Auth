import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Express } from "express";
import request from "supertest";
import { createOidcApp } from "../src/app.js";
import { createClientSecretDigest } from "../src/crypto.js";

async function clientsConfig() {
  const path = join(mkdtempSync(join(tmpdir(), "agent-api-")), "clients.json");
  writeFileSync(
    path,
    JSON.stringify({
      clients: [
        {
          clientId: "bootstrap-site",
          clientSecretDigest:
            await createClientSecretDigest("bootstrap-secret"),
          redirectUris: ["http://localhost:3002/callback"],
          scopeWhitelist: ["openid", "profile"],
        },
      ],
    }),
  );
  return path;
}

async function createApp(overrides: NodeJS.ProcessEnv = {}) {
  const env = {
    APP_ENV: "test",
    AUTH_PROVIDER: "mock",
    OIDC_COOKIE_SECURE: "false",
    OIDC_ISSUER: "http://127.0.0.1:3003",
    OIDC_KEY_ENCRYPTION_SECRET: "test-agent-key",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-agent-artifact",
    OIDC_CLIENTS_CONFIG_PATH: await clientsConfig(),
    OIDC_ADMIN_SUBJECT_IDS: "subj_admin",
    OIDC_CLIENT_SECRET_ROTATE_MINIMUM_INTERVAL_SECONDS: "0",
    OIDC_AGENT_API_ENABLED: "true",
    ...overrides,
  };
  return createOidcApp(env, {
    runtimePolicyOverrides: {
      clientSecretRotateMinimumIntervalSeconds: 0,
    },
  });
}

async function seedAdmin(
  state: Awaited<ReturnType<typeof createApp>>["state"],
) {
  const now = new Date().toISOString();
  await state.persistence.identity.createSubjectWithIdentity(
    {
      subjectId: "subj_admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    {
      subjectId: "subj_admin",
      provider: "mock",
      schoolUid: "admin-account",
      identityKey: "mock:admin-account",
      currentStudentStatus: "active",
      school: "cqut",
      createdAt: now,
      updatedAt: now,
    },
  );
  await state.persistence.identity.upsertProfile({
    subjectId: "subj_admin",
    preferredUsername: "admin-account",
    displayName: "Admin",
    emailVerified: false,
    updatedAt: now,
  });
}

async function agentLogin(app: Express, account: string) {
  const response = await request(app)
    .post("/api/agent/auth/login")
    .send({ account, password: "valid-password" });
  assert.equal(response.status, 200);
  return response;
}

const clientInput = {
  clientType: "web",
  displayName: "Agent Web Client",
  description: "via agent api",
  redirectUris: ["http://localhost:3010/callback"],
  postLogoutRedirectUris: [],
  scopeWhitelist: ["openid", "profile"],
};

test("agent login returns bearer token without csrf", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const login = await agentLogin(app, "admin-account");
    assert.equal(login.body.tokenType, "Bearer");
    assert.equal(typeof login.body.accessToken, "string");
    assert.equal(login.body.user.isAdmin, true);
    assert.equal("csrfToken" in login.body, false);
  } finally {
    await state.close();
  }
});

test("agent protected routes require bearer token", async () => {
  const { app, state } = await createApp();
  try {
    const response = await request(app).get("/api/agent/projects");
    assert.equal(response.status, 401);
    assert.equal(response.body.error, "login_required");
  } finally {
    await state.close();
  }
});

test("agent mutations work without csrf header", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const login = await agentLogin(app, "admin-account");
    const token = login.body.accessToken as string;
    const created = await request(app)
      .post("/api/agent/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Agent Project", description: "test" });
    assert.equal(created.status, 201);
    assert.equal(created.body.project.name, "Agent Project");
  } finally {
    await state.close();
  }
});

test("management mutations still require csrf", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const agent = request.agent(app);
    const context = await agent.get("/api/management/auth/context");
    const signedIn = await agent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", context.body.csrfToken)
      .send({ account: "admin-account", password: "valid-password" });
    assert.equal(signedIn.status, 200);

    const withoutCsrf = await agent
      .post("/api/management/projects")
      .send({ name: "Should fail", description: "" });
    assert.equal(withoutCsrf.status, 400);
    assert.equal(withoutCsrf.body.error, "invalid_request");
  } finally {
    await state.close();
  }
});

test("agent client lifecycle create revision and rotate secret", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const login = await agentLogin(app, "admin-account");
    const token = login.body.accessToken as string;
    const auth = (req: request.Test) =>
      req.set("Authorization", `Bearer ${token}`);

    const project = await auth(
      request(app)
        .post("/api/agent/projects")
        .send({ name: "Client Project", description: "" }),
    );
    assert.equal(project.status, 201);
    const projectId = project.body.project.projectId as string;

    const created = await auth(
      request(app)
        .post(`/api/agent/projects/${projectId}/clients`)
        .send(clientInput),
    );
    assert.equal(created.status, 201);
    assert.equal(typeof created.body.clientSecret, "string");
    const clientId = created.body.client.clientId as string;

    const revised = await auth(
      request(app)
        .put(`/api/agent/projects/${projectId}/clients/${clientId}/revision`)
        .send({
          redirectUris: ["http://localhost:3010/new-callback"],
          scopeWhitelist: ["openid", "profile", "email"],
        }),
    );
    assert.equal(revised.status, 200);
    assert.deepEqual(revised.body.client.activeRevision.redirectUris, [
      "http://localhost:3010/new-callback",
    ]);

    const rotated = await auth(
      request(app)
        .post(
          `/api/agent/projects/${projectId}/clients/${clientId}/secrets/rotate`,
        )
        .send({ clientVersion: revised.body.client.clientVersion }),
    );
    assert.equal(rotated.status, 201);
    assert.equal(typeof rotated.body.secret.value, "string");
  } finally {
    await state.close();
  }
});

test("agent auth me and logout", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const login = await agentLogin(app, "admin-account");
    const token = login.body.accessToken as string;

    const me = await request(app)
      .get("/api/agent/auth/me")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.subjectId, "subj_admin");

    const logout = await request(app)
      .post("/api/agent/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(logout.status, 204);

    const afterLogout = await request(app)
      .get("/api/agent/projects")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(afterLogout.status, 401);
  } finally {
    await state.close();
  }
});

test("agent openapi.json is served", async () => {
  const { app, state } = await createApp();
  try {
    const spec = await request(app).get("/api/agent/openapi.json");
    assert.equal(spec.status, 200);
    assert.equal(spec.body.openapi, "3.1.0");
    assert.ok(spec.body.paths["/auth/login"]);
    assert.equal(spec.body.info["x-agent-instructions"], "/instructions");
  } finally {
    await state.close();
  }
});

test("agent instructions are served without auth", async () => {
  const { app, state } = await createApp();
  try {
    const instructions = await request(app).get("/api/agent/instructions");
    assert.equal(instructions.status, 200);
    assert.equal(instructions.body.version, "1.0.0");
    assert.equal(instructions.body.contentType, "text/markdown");
    assert.match(
      instructions.body.baseUrl,
      /^http:\/\/127\.0\.0\.1:\d+\/api\/agent$/,
    );
    assert.equal(
      instructions.body.openapiUrl,
      `${instructions.body.baseUrl}/openapi.json`,
    );
    assert.match(instructions.body.prompt, /CQUT Auth 客户端管理入口/);
    assert.doesNotMatch(instructions.body.prompt, /\{\{baseUrl\}\}/);
  } finally {
    await state.close();
  }
});

test("agent api disabled returns 404", async () => {
  const { app, state } = await createApp({ OIDC_AGENT_API_ENABLED: "false" });
  try {
    const response = await request(app).post("/api/agent/auth/login").send({
      account: "admin-account",
      password: "valid-password",
    });
    assert.equal(response.status, 404);
  } finally {
    await state.close();
  }
});

test("agent login rejects invalid credentials", async () => {
  const { app, state } = await createApp();
  try {
    const response = await request(app)
      .post("/api/agent/auth/login")
      .send({ account: "admin-account", password: "" });
    assert.equal(response.status, 401);
    assert.equal(response.body.error, "access_denied");
  } finally {
    await state.close();
  }
});
