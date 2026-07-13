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
    OIDC_CLIENT_SECRET_ROTATE_MINIMUM_INTERVAL_SECONDS: "0",
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
  const response = await agent
    .post("/api/management/auth/login")
    .set("X-CSRF-Token", context.body.csrfToken)
    .send({ account, password: "valid-password" });
  assert.equal(response.status, 200);
  return response;
}

const input = {
  clientType: "web",
  displayName: "New Web",
  description: "",
  redirectUris: ["http://localhost:3004/callback"],
  postLogoutRedirectUris: [],
  scopeWhitelist: ["openid", "profile"],
};

test("management API exposes separate lifecycle and revision workflows", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const created = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send(input);
    assert.equal(created.status, 201);
    assert.equal(created.body.client.lifecycleStatus, "draft");
    assert.equal(created.body.client.proposedRevision.status, "draft");
    assert.equal(typeof created.body.clientSecret, "string");
    assert.equal("clientSecretDigest" in created.body.client, false);

    const clientId = created.body.client.clientId;
    const draft = created.body.client.proposedRevision;
    const submitted = await admin
      .post(`/api/management/clients/${clientId}/revision/submit`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ revisionId: draft.revisionId, revisionVersion: draft.version });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.client.proposedRevision.status, "pending");

    const pending = submitted.body.client.proposedRevision;
    const approved = await admin
      .post(`/api/management/admin/reviews/${clientId}/approve`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: pending.revisionId,
        revisionVersion: pending.version,
      });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.client.lifecycleStatus, "active");
    assert.equal(approved.body.client.proposedRevision, null);

    const typeChange = await admin
      .patch(`/api/management/clients/${clientId}`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: approved.body.client.clientVersion,
        clientType: "spa",
      });
    assert.equal(typeChange.status, 400);

    const sensitive = await admin
      .put(`/api/management/clients/${clientId}/revision`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        redirectUris: ["http://localhost:3004/new-callback"],
        scopeWhitelist: ["openid"],
      });
    assert.equal(sensitive.status, 200);
    assert.equal(sensitive.body.client.proposedRevision.status, "pending");
    assert.deepEqual(
      sensitive.body.client.activeRevision.redirectUris,
      input.redirectUris,
    );
    const authorize = {
      client_id: clientId,
      response_type: "code",
      scope: "openid profile",
      state: "revision-state",
      nonce: "revision-nonce",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
    };
    const oldStillWorks = await request(app)
      .get("/auth")
      .query({ ...authorize, redirect_uri: input.redirectUris[0] });
    assert.ok(oldStillWorks.status === 302 || oldStillWorks.status === 303);
    const pendingNotLive = await request(app)
      .get("/auth")
      .query({
        ...authorize,
        redirect_uri: "http://localhost:3004/new-callback",
      });
    assert.equal(pendingNotLive.status, 400);

    const frozen = await admin
      .put(`/api/management/clients/${clientId}/revision`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ redirectUris: ["http://localhost:3004/other"] });
    assert.equal(frozen.status, 409);

    const proposed = sensitive.body.client.proposedRevision;
    const rejected = await admin
      .post(`/api/management/admin/reviews/${clientId}/reject`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: proposed.revisionId,
        revisionVersion: proposed.version,
        reason: "callback ownership is unclear",
      });
    assert.equal(
      rejected.body.client.proposedRevision.rejectionReason,
      "callback ownership is unclear",
    );
    assert.deepEqual(
      rejected.body.client.activeRevision.redirectUris,
      input.redirectUris,
    );
    const oldAfterReject = await request(app)
      .get("/auth")
      .query({ ...authorize, redirect_uri: input.redirectUris[0] });
    assert.ok(oldAfterReject.status === 302 || oldAfterReject.status === 303);
    const redraft = await admin
      .put(`/api/management/clients/${clientId}/revision`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        redirectUris: ["http://localhost:3004/new-callback"],
        scopeWhitelist: ["openid", "profile", "email"],
      });
    const newDraft = redraft.body.client.proposedRevision;
    const resubmitted = await admin
      .post(`/api/management/clients/${clientId}/revision/submit`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: newDraft.revisionId,
        revisionVersion: newDraft.version,
      });
    const newPending = resubmitted.body.client.proposedRevision;
    const secondApproved = await admin
      .post(`/api/management/admin/reviews/${clientId}/approve`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: newPending.revisionId,
        revisionVersion: newPending.version,
      });
    assert.equal(secondApproved.status, 200);
    assert.equal(secondApproved.body.client.proposedRevision, null);
    const revisionFour = await admin
      .put(`/api/management/clients/${clientId}/revision`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ redirectUris: ["http://localhost:3004/revision-4"] });
    assert.equal(revisionFour.status, 200);
    assert.equal(revisionFour.body.client.proposedRevision.revisionNumber, 4);
    assert.deepEqual(revisionFour.body.client.proposedRevision.scopeWhitelist, [
      "openid",
      "profile",
      "email",
    ]);
    const newNowWorks = await request(app)
      .get("/auth")
      .query({
        ...authorize,
        redirect_uri: "http://localhost:3004/new-callback",
      });
    assert.ok(newNowWorks.status === 302 || newNowWorks.status === 303);
    assert.equal(
      (
        await request(app)
          .get("/auth")
          .query({ ...authorize, redirect_uri: input.redirectUris[0] })
      ).status,
      400,
    );

    const outsider = request.agent(app);
    const outsiderLogin = await login(outsider, "other-account");
    assert.equal(
      (await outsider.get(`/api/management/clients/${clientId}`)).status,
      404,
    );
    assert.equal(
      (await outsider.get("/api/management/admin/reviews")).status,
      403,
    );
    assert.equal(
      (
        await outsider
          .post(`/api/management/clients/${clientId}/revision/withdraw`)
          .set("X-CSRF-Token", outsiderLogin.body.csrfToken)
          .send({
            revisionId: proposed.revisionId,
            revisionVersion: proposed.version,
          })
      ).status,
      404,
    );
  } finally {
    await state.closeOidcServices();
    await state.rateLimitService.close();
    await state.store.close();
  }
});

test("management API rejects concurrent approval and approval after disable", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const created = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ ...input, clientType: "spa" });
    const draft = created.body.client.proposedRevision;
    const submitted = await admin
      .post(
        `/api/management/clients/${created.body.client.clientId}/revision/submit`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ revisionId: draft.revisionId, revisionVersion: draft.version });
    const pending = submitted.body.client.proposedRevision;
    const endpoint = `/api/management/admin/reviews/${created.body.client.clientId}/approve`;
    const [first, second] = await Promise.all([
      admin.post(endpoint).set("X-CSRF-Token", signedIn.body.csrfToken).send({
        revisionId: pending.revisionId,
        revisionVersion: pending.version,
      }),
      admin.post(endpoint).set("X-CSRF-Token", signedIn.body.csrfToken).send({
        revisionId: pending.revisionId,
        revisionVersion: pending.version,
      }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);

    const another = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ ...input, displayName: "Disabled review", clientType: "spa" });
    const anotherDraft = another.body.client.proposedRevision;
    const anotherPending = await admin
      .post(
        `/api/management/clients/${another.body.client.clientId}/revision/submit`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: anotherDraft.revisionId,
        revisionVersion: anotherDraft.version,
      });
    await admin
      .post(`/api/management/clients/${another.body.client.clientId}/disable`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ clientVersion: anotherPending.body.client.clientVersion });
    const blocked = await admin
      .post(
        `/api/management/admin/reviews/${another.body.client.clientId}/approve`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: anotherPending.body.client.proposedRevision.revisionId,
        revisionVersion: anotherPending.body.client.proposedRevision.version,
      });
    assert.equal(blocked.status, 409);
  } finally {
    await state.closeOidcServices();
    await state.rateLimitService.close();
    await state.store.close();
  }
});

test("management API rotates secrets and isolates authorization revocation", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const created = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send(input);
    const clientId = created.body.client.clientId as string;
    assert.equal(created.body.client.secrets.length, 1);
    assert.equal("secretDigest" in created.body.client.secrets[0], false);

    const missingCsrf = await admin
      .post(`/api/management/clients/${clientId}/secrets/rotate`)
      .send({ clientVersion: created.body.client.clientVersion });
    assert.equal(missingCsrf.status, 400);

    const digestSubmission = await admin
      .post(`/api/management/clients/${clientId}/secrets/rotate`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: created.body.client.clientVersion,
        clientSecretDigest: "scrypt$submitted",
      });
    assert.equal(digestSubmission.status, 400);

    const outsider = request.agent(app);
    const outsiderLogin = await login(outsider, "secret-outsider");
    const denied = await outsider
      .post(`/api/management/clients/${clientId}/secrets/rotate`)
      .set("X-CSRF-Token", outsiderLogin.body.csrfToken)
      .send({ clientVersion: created.body.client.clientVersion });
    assert.equal(denied.status, 404);

    const rotated = await admin
      .post(`/api/management/clients/${clientId}/secrets/rotate`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: created.body.client.clientVersion,
        gracePeriodSeconds: 60,
      });
    assert.equal(rotated.status, 201);
    assert.equal(typeof rotated.body.secret.value, "string");
    assert.equal(rotated.body.client.secrets.length, 2);

    const retiring = rotated.body.client.secrets.find(
      (secret: { status: string }) => secret.status === "retiring",
    );
    const stale = await admin
      .post(
        `/api/management/clients/${clientId}/secrets/${retiring.secretId}/revoke`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: created.body.client.clientVersion,
        secretVersion: retiring.version,
      });
    assert.equal(stale.status, 409);
    const revoked = await admin
      .post(
        `/api/management/clients/${clientId}/secrets/${retiring.secretId}/revoke`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: rotated.body.client.clientVersion,
        secretVersion: retiring.version,
      });
    assert.equal(revoked.status, 200);
    assert.equal(
      revoked.body.client.secrets.find(
        (secret: { secretId: string }) => secret.secretId === retiring.secretId,
      ).status,
      "revoked",
    );

    await state.store.upsertArtifact(
      "Grant:owned",
      "Grant",
      { clientId, value: "owned" },
      120,
    );
    await state.store.upsertArtifact(
      "Grant:other",
      "Grant",
      { clientId: "bootstrap-site", value: "other" },
      120,
    );
    await state.store.upsertArtifact(
      "Session:shared",
      "Session",
      { clientId, value: "session" },
      120,
    );
    const authorizations = await admin
      .post(`/api/management/clients/${clientId}/authorizations/revoke`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ clientVersion: revoked.body.client.clientVersion });
    assert.equal(authorizations.status, 200);
    assert.equal(await state.store.findArtifact("Grant:owned"), undefined);
    assert.ok(await state.store.findArtifact("Grant:other"));
    assert.ok(await state.store.findArtifact("Session:shared"));

    const disabled = await admin
      .post(`/api/management/clients/${clientId}/disable`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ clientVersion: authorizations.body.client.clientVersion });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.client.lifecycleStatus, "disabled");
    assert.ok(
      disabled.body.client.secrets.every(
        (secret: { status: string }) => secret.status === "revoked",
      ),
    );
    const audits = await state.store.listOidcClientAuditLogs(clientId);
    assert.equal(
      JSON.stringify(audits).includes(rotated.body.secret.value),
      false,
    );
    assert.equal(JSON.stringify(audits).includes("scrypt$"), false);
  } finally {
    await state.closeOidcServices();
    await state.rateLimitService.close();
    await state.store.close();
  }
});

test("management API rate limits repeated zero-grace secret rotation", async () => {
  const { app, state } = await createApp({
    OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_CLIENT_MAX: "1",
    OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_IP_MAX: "10",
    OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_WINDOW_SECONDS: "3600",
    OIDC_CLIENT_SECRET_ROTATE_MINIMUM_INTERVAL_SECONDS: "0",
  });
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const created = await admin
      .post("/api/management/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send(input);
    const path = `/api/management/clients/${created.body.client.clientId}/secrets/rotate`;
    const first = await admin
      .post(path)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: created.body.client.clientVersion,
        gracePeriodSeconds: 0,
      });
    assert.equal(first.status, 201);
    const blocked = await admin
      .post(path)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: first.body.client.clientVersion,
        gracePeriodSeconds: 0,
      });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers["retry-after"], "3600");
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

test("management API rate limits client creation by source IP", async () => {
  const { app, state } = await createApp({
    OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_SUBJECT_MAX: "5",
    OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_IP_MAX: "1",
  });
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
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
    assert.deepEqual((await request(app).get("/health/live")).body, {
      status: "live",
    });
  } finally {
    await state.closeOidcServices();
    await state.rateLimitService.close();
    await state.store.close();
  }
});
