import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import request from "supertest";
import { createOidcApp } from "../src/app.js";
import { createClientSecretDigest } from "../src/crypto.js";

async function clientsConfig() {
  const path = join(
    mkdtempSync(join(tmpdir(), "management-api-")),
    "clients.json",
  );
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
  return createOidcApp({
    APP_ENV: "test",
    AUTH_PROVIDER: "mock",
    OIDC_COOKIE_SECURE: "false",
    OIDC_ISSUER: "http://127.0.0.1:3003",
    OIDC_KEY_ENCRYPTION_SECRET: "test-management-key",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-management-artifact",
    OIDC_CLIENTS_CONFIG_PATH: await clientsConfig(),
    OIDC_ADMIN_SUBJECT_IDS: "subj_admin",
    ...overrides,
  });
}

async function seedAdmin(
  state: Awaited<ReturnType<typeof createApp>>["state"],
) {
  const now = new Date().toISOString();
  await state.store.createSubjectWithIdentity(
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
  await state.store.upsertProfile({
    subjectId: "subj_admin",
    preferredUsername: "admin-account",
    displayName: "Admin",
    emailVerified: false,
    updatedAt: now,
  });
}

async function login(agent: request.Agent, account: string) {
  const context = await agent.get("/api/management/auth/context");
  assert.equal(context.status, 200);
  const response = await agent
    .post("/api/management/auth/login")
    .set("X-CSRF-Token", context.body.csrfToken)
    .send({ account, password: "valid-password" });
  assert.equal(response.status, 200);
  return response;
}

test("management API protects CRUD, returns Web secret once, and supports admin approval", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    assert.equal(signedIn.body.user.isAdmin, true);
    const setCookies = signedIn.headers["set-cookie"] as unknown as string[];
    assert.match(setCookies.join(";"), /cqut_manage_sid=/);
    assert.match(setCookies.join(";"), /HttpOnly/);
    assert.match(setCookies.join(";"), /SameSite=Lax/);

    const created = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientType: "web",
        displayName: "New Web",
        description: "",
        redirectUris: ["http://localhost:3004/callback"],
        postLogoutRedirectUris: [],
        scopeWhitelist: ["openid", "profile"],
      });
    assert.equal(created.status, 201);
    assert.equal(created.body.client.status, "pending");
    assert.equal(typeof created.body.clientSecret, "string");
    assert.equal("clientSecretDigest" in created.body.client, false);

    const detail = await admin.get(
      `/api/management/clients/${created.body.client.clientId}`,
    );
    assert.equal(detail.status, 200);
    assert.equal("clientSecret" in detail.body.client, false);

    const approved = await admin
      .post(
        `/api/management/admin/reviews/${created.body.client.clientId}/approve`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ version: created.body.client.version });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.client.status, "active");

    const typeChange = await admin
      .patch(`/api/management/clients/${created.body.client.clientId}`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ version: approved.body.client.version, clientType: "spa" });
    assert.equal(typeChange.status, 400);

    const activeSensitiveChange = await admin
      .patch(`/api/management/clients/${created.body.client.clientId}`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        version: approved.body.client.version,
        redirectUris: ["http://localhost:3004/new-callback"],
      });
    assert.equal(activeSensitiveChange.status, 409);
    assert.equal(
      (
        await admin.get(
          `/api/management/clients/${created.body.client.clientId}`,
        )
      ).body.client.status,
      "active",
    );

    const stale = await admin
      .patch(`/api/management/clients/${created.body.client.clientId}`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ version: 1, displayName: "Stale name" });
    assert.equal(stale.status, 409);

    const wrongOrigin = await admin
      .post(`/api/management/clients/${created.body.client.clientId}/disable`)
      .set("Origin", "https://attacker.example")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ version: approved.body.client.version });
    assert.equal(wrongOrigin.status, 400);

    const missingCsrf = await admin
      .post(`/api/management/clients/${created.body.client.clientId}/disable`)
      .send({ version: approved.body.client.version });
    assert.equal(missingCsrf.status, 400);

    const forgedDigest = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientType: "web",
        displayName: "Forged",
        description: "",
        redirectUris: ["http://localhost:3005/callback"],
        postLogoutRedirectUris: [],
        scopeWhitelist: ["openid"],
        clientSecretDigest: "scrypt$forged",
      });
    assert.equal(forgedDigest.status, 400);

    const missingOpenid = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientType: "spa",
        displayName: "Not OIDC",
        description: "",
        redirectUris: ["http://localhost:3006/callback"],
        postLogoutRedirectUris: [],
        scopeWhitelist: ["profile"],
      });
    assert.equal(missingOpenid.status, 400);

    const reviewCandidate = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientType: "spa",
        displayName: "Review candidate",
        description: "",
        redirectUris: ["http://localhost:3007/callback"],
        postLogoutRedirectUris: [],
        scopeWhitelist: ["openid"],
      });
    assert.equal(reviewCandidate.status, 201);
    const rejected = await admin
      .post(
        `/api/management/admin/reviews/${reviewCandidate.body.client.clientId}/reject`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        version: reviewCandidate.body.client.version,
        reason: "add details",
      });
    assert.equal(rejected.body.client.rejectionReason, "add details");
    const draft = await admin
      .patch(`/api/management/clients/${reviewCandidate.body.client.clientId}`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        version: rejected.body.client.version,
        description: "details added",
      });
    assert.equal(draft.body.client.status, "draft");
    const submitted = await admin
      .post(
        `/api/management/clients/${reviewCandidate.body.client.clientId}/submit`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ version: draft.body.client.version });
    assert.equal(submitted.body.client.status, "pending");

    const outsider = request.agent(app);
    const outsiderLogin = await login(outsider, "other-account");
    assert.equal(outsiderLogin.body.user.isAdmin, false);
    const hidden = await outsider.get(
      `/api/management/clients/${created.body.client.clientId}`,
    );
    assert.equal(hidden.status, 404);
    const reviews = await outsider.get("/api/management/admin/reviews");
    assert.equal(reviews.status, 403);
  } finally {
    await state.closeOidcServices();
    await state.rateLimitService.close();
    await state.store.close();
  }
});

test("management API rate limits client creation by subject", async () => {
  const { app, state } = await createApp({
    OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_SUBJECT_MAX: "1",
  });
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const input = {
      clientType: "spa",
      displayName: "Rate limited",
      description: "",
      redirectUris: ["http://localhost:3010/callback"],
      postLogoutRedirectUris: [],
      scopeWhitelist: ["openid"],
    };
    assert.equal(
      (
        await admin
          .post("/api/management/clients")
          .set("X-CSRF-Token", signedIn.body.csrfToken)
          .send(input)
      ).status,
      201,
    );
    const limited = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send(input);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers["retry-after"]);
  } finally {
    await state.closeOidcServices();
    await state.rateLimitService.close();
    await state.store.close();
  }
});

test("management API enforces configured owner quota", async () => {
  const { app, state } = await createApp({
    OIDC_MANAGEMENT_CLIENT_MAX_PER_SUBJECT: "1",
    OIDC_MANAGEMENT_CLIENT_MAX_PENDING_PER_SUBJECT: "1",
    OIDC_MANAGEMENT_CLIENT_QUOTA_ADMIN_EXEMPT: "false",
  });
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const input = {
      clientType: "spa",
      displayName: "Quota limited",
      description: "",
      redirectUris: ["http://localhost:3011/callback"],
      postLogoutRedirectUris: [],
      scopeWhitelist: ["openid"],
    };
    assert.equal(
      (
        await admin
          .post("/api/management/clients")
          .set("X-CSRF-Token", signedIn.body.csrfToken)
          .send(input)
      ).status,
      201,
    );
    const limited = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send(input);
    assert.equal(limited.status, 409);
    assert.equal(limited.body.error, "client_quota_exceeded");
  } finally {
    await state.closeOidcServices();
    await state.rateLimitService.close();
    await state.store.close();
  }
});

test("liveness does not depend on dynamic client CSP lookup", async () => {
  const { app, state } = await createApp();
  state.store.listActiveOidcClients = async () => {
    throw new Error("database unavailable");
  };
  try {
    const response = await request(app).get("/health/live");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "live" });
  } finally {
    await state.closeOidcServices();
    await state.rateLimitService.close();
    await state.store.close();
  }
});
