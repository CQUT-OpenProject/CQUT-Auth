import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import request from "supertest";
import { createOidcApp } from "../src/app.js";
import { createClientSecretDigest } from "../src/crypto.js";
import type { EmailSender } from "../src/email/email-sender.js";
import type { PolicyValues } from "../src/runtime-policy.js";

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

async function createApp(
  overrides: NodeJS.ProcessEnv = {},
  dependencies: { emailSender?: EmailSender; requestRestart?: () => void } = {},
) {
  return createOidcApp(
    {
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
    },
    { ...dependencies, runtimePolicyOverrides: testPolicyOverrides(overrides) },
  );
}

function testPolicyOverrides(env: NodeJS.ProcessEnv): Partial<PolicyValues> {
  const names: Record<string, keyof PolicyValues> = {
    OIDC_LOGIN_RATE_LIMIT_MAX: "loginRateLimitMax",
    OIDC_LOGIN_RATE_LIMIT_WINDOW_SECONDS: "loginRateLimitWindowSeconds",
    OIDC_LOGIN_FAILURE_LIMIT: "loginFailureLimit",
    OIDC_LOGIN_FAILURE_WINDOW_SECONDS: "loginFailureWindowSeconds",
    OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_SUBJECT_MAX:
      "clientSecretRotateRateLimitSubjectMax",
    OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_CLIENT_MAX:
      "clientSecretRotateRateLimitClientMax",
    OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_IP_MAX:
      "clientSecretRotateRateLimitIpMax",
    OIDC_CLIENT_SECRET_ROTATE_RATE_LIMIT_WINDOW_SECONDS:
      "clientSecretRotateRateLimitWindowSeconds",
    OIDC_CLIENT_SECRET_ROTATE_MINIMUM_INTERVAL_SECONDS:
      "clientSecretRotateMinimumIntervalSeconds",
    OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_SUBJECT_MAX:
      "managementClientCreateRateLimitSubjectMax",
    OIDC_MANAGEMENT_CLIENT_CREATE_RATE_LIMIT_IP_MAX:
      "managementClientCreateRateLimitIpMax",
    OIDC_MANAGEMENT_PROJECT_QUOTA_ADMIN_EXEMPT:
      "managementProjectQuotaAdminExempt",
    OIDC_MANAGEMENT_PROJECT_MAX_ACTIVE_PER_SUBJECT:
      "managementProjectMaxActivePerSubject",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_SUBJECT_MAX:
      "managementProjectCreateRateLimitSubjectMax",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_IP_MAX:
      "managementProjectCreateRateLimitIpMax",
  };
  const result: Partial<PolicyValues> = {
    clientSecretRotateMinimumIntervalSeconds: 0,
  };
  for (const [name, key] of Object.entries(names)) {
    const value = env[name];
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] =
        value === "true" || value === "false"
          ? value === "true"
          : Number(value);
    }
  }
  return result;
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

test("management login rejects oversized credentials", async () => {
  const { app, state } = await createApp();
  try {
    const agent = request.agent(app);
    const context = await agent.get("/api/management/auth/context");
    const response = await agent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", context.body.csrfToken)
      .send({ account: "a".repeat(129), password: "p".repeat(257) });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "invalid_request");
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management login normalizes account rate-limit keys", async () => {
  const { app, state } = await createApp({ OIDC_LOGIN_RATE_LIMIT_MAX: "1" });
  try {
    const firstAgent = request.agent(app);
    const firstContext = await firstAgent.get("/api/management/auth/context");
    const first = await firstAgent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", firstContext.body.csrfToken)
      .send({ account: "Student001", password: "valid-password" });
    const secondAgent = request.agent(app);
    const secondContext = await secondAgent.get("/api/management/auth/context");
    const second = await secondAgent
      .post("/api/management/auth/login")
      .set("X-CSRF-Token", secondContext.body.csrfToken)
      .send({ account: "STUDENT001", password: "valid-password" });

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management login blocks account spraying from one ip", async () => {
  const { app, state } = await createApp({ OIDC_LOGIN_RATE_LIMIT_MAX: "2" });
  try {
    const statuses: number[] = [];
    for (const account of ["spray-a", "spray-b", "spray-c"]) {
      const agent = request.agent(app);
      const context = await agent.get("/api/management/auth/context");
      const response = await agent
        .post("/api/management/auth/login")
        .set("X-CSRF-Token", context.body.csrfToken)
        .send({ account, password: "valid-password" });
      statuses.push(response.status);
    }

    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    await state.persistence.runtime.close();
  }
});

test("management API exposes separate lifecycle and revision workflows", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const created = await admin
      .post("/api/management/projects/system/clients")
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
      .post(
        `/api/management/projects/system/clients/${clientId}/revision/submit`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ revisionId: draft.revisionId, revisionVersion: draft.version });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.client.proposedRevision.status, "pending");

    const pending = submitted.body.client.proposedRevision;
    const approved = await admin
      .post(
        `/api/management/admin/projects/system/clients/${clientId}/revisions/${pending.revisionId}/approve`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: pending.revisionId,
        revisionVersion: pending.version,
      });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.client.lifecycleStatus, "active");
    assert.equal(approved.body.client.proposedRevision, null);

    const typeChange = await admin
      .patch(`/api/management/projects/system/clients/${clientId}`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: approved.body.client.clientVersion,
        clientType: "spa",
      });
    assert.equal(typeChange.status, 400);

    const sensitive = await admin
      .put(`/api/management/projects/system/clients/${clientId}/revision`)
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
      .put(`/api/management/projects/system/clients/${clientId}/revision`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ redirectUris: ["http://localhost:3004/other"] });
    assert.equal(frozen.status, 409);

    const proposed = sensitive.body.client.proposedRevision;
    const rejected = await admin
      .post(
        `/api/management/admin/projects/system/clients/${clientId}/revisions/${proposed.revisionId}/reject`,
      )
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
      .put(`/api/management/projects/system/clients/${clientId}/revision`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        redirectUris: ["http://localhost:3004/new-callback"],
        scopeWhitelist: ["openid", "profile", "email"],
      });
    const newDraft = redraft.body.client.proposedRevision;
    const resubmitted = await admin
      .post(
        `/api/management/projects/system/clients/${clientId}/revision/submit`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: newDraft.revisionId,
        revisionVersion: newDraft.version,
      });
    const newPending = resubmitted.body.client.proposedRevision;
    const secondApproved = await admin
      .post(
        `/api/management/admin/projects/system/clients/${clientId}/revisions/${newPending.revisionId}/approve`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: newPending.revisionId,
        revisionVersion: newPending.version,
      });
    assert.equal(secondApproved.status, 200);
    assert.equal(secondApproved.body.client.proposedRevision, null);
    const revisionFour = await admin
      .put(`/api/management/projects/system/clients/${clientId}/revision`)
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
      (
        await outsider.get(
          `/api/management/projects/system/clients/${clientId}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (await outsider.get("/api/management/admin/reviews")).status,
      403,
    );
    assert.equal(
      (
        await outsider
          .post(
            `/api/management/projects/system/clients/${clientId}/revision/withdraw`,
          )
          .set("X-CSRF-Token", outsiderLogin.body.csrfToken)
          .send({
            revisionId: proposed.revisionId,
            revisionVersion: proposed.version,
          })
      ).status,
      404,
    );
  } finally {
    await state.close();
  }
});

test("project API enforces roles, last-owner protection, and immediate removal", async () => {
  const { app, state } = await createApp();
  try {
    const ownerAgent = request.agent(app);
    const maintainerAgent = request.agent(app);
    const viewerAgent = request.agent(app);
    const outsiderAgent = request.agent(app);
    const ownerLogin = await login(ownerAgent, "project-owner");
    const maintainerLogin = await login(maintainerAgent, "project-maintainer");
    const viewerLogin = await login(viewerAgent, "project-viewer");
    await login(outsiderAgent, "project-outsider");

    const createdProject = await ownerAgent
      .post("/api/management/projects")
      .set("X-CSRF-Token", ownerLogin.body.csrfToken)
      .send({ name: "API Project", description: "" });
    assert.equal(createdProject.status, 201);
    const projectId = createdProject.body.project.projectId as string;
    let projectVersion = createdProject.body.project.version as number;

    const maintainerAdded = await ownerAgent
      .post(`/api/management/projects/${projectId}/members`)
      .set("X-CSRF-Token", ownerLogin.body.csrfToken)
      .send({
        subjectId: maintainerLogin.body.user.subjectId,
        role: "maintainer",
        expectedProjectVersion: projectVersion,
      });
    assert.equal(maintainerAdded.status, 201);
    projectVersion = maintainerAdded.body.project.version;
    const viewerAdded = await ownerAgent
      .post(`/api/management/projects/${projectId}/members`)
      .set("X-CSRF-Token", ownerLogin.body.csrfToken)
      .send({
        subjectId: viewerLogin.body.user.subjectId,
        role: "viewer",
        expectedProjectVersion: projectVersion,
      });
    projectVersion = viewerAdded.body.project.version;

    const client = await maintainerAgent
      .post(`/api/management/projects/${projectId}/clients`)
      .set("X-CSRF-Token", maintainerLogin.body.csrfToken)
      .send({ ...input, clientType: "spa" });
    assert.equal(client.status, 201);
    const clientId = client.body.client.clientId as string;
    assert.equal(
      (
        await viewerAgent.get(
          `/api/management/projects/${projectId}/clients/${clientId}`,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await viewerAgent
          .post(`/api/management/projects/${projectId}/clients`)
          .set("X-CSRF-Token", viewerLogin.body.csrfToken)
          .send({ ...input, clientType: "spa" })
      ).status,
      403,
    );
    assert.equal(
      (
        await outsiderAgent.get(
          `/api/management/projects/${projectId}/clients/${clientId}`,
        )
      ).status,
      404,
    );

    const removed = await ownerAgent
      .delete(
        `/api/management/projects/${projectId}/members/${maintainerLogin.body.user.subjectId}`,
      )
      .set("X-CSRF-Token", ownerLogin.body.csrfToken)
      .send({ expectedProjectVersion: projectVersion });
    assert.equal(removed.status, 200);
    projectVersion = removed.body.project.version;
    assert.equal(
      (
        await maintainerAgent.get(
          `/api/management/projects/${projectId}/clients/${clientId}`,
        )
      ).status,
      404,
    );
    const lastOwner = await ownerAgent
      .delete(
        `/api/management/projects/${projectId}/members/${ownerLogin.body.user.subjectId}`,
      )
      .set("X-CSRF-Token", ownerLogin.body.csrfToken)
      .send({ expectedProjectVersion: projectVersion });
    assert.equal(lastOwner.status, 409);
    assert.equal(lastOwner.body.error, "last_owner_required");
  } finally {
    await state.close();
  }
});

test("management API rejects concurrent approval and approval after disable", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const created = await admin
      .post("/api/management/projects/system/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ ...input, clientType: "spa" });
    const draft = created.body.client.proposedRevision;
    const submitted = await admin
      .post(
        `/api/management/projects/system/clients/${created.body.client.clientId}/revision/submit`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ revisionId: draft.revisionId, revisionVersion: draft.version });
    const pending = submitted.body.client.proposedRevision;
    const endpoint = `/api/management/admin/projects/system/clients/${created.body.client.clientId}/revisions/${pending.revisionId}/approve`;
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
      .post("/api/management/projects/system/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ ...input, displayName: "Disabled review", clientType: "spa" });
    const anotherDraft = another.body.client.proposedRevision;
    const anotherPending = await admin
      .post(
        `/api/management/projects/system/clients/${another.body.client.clientId}/revision/submit`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: anotherDraft.revisionId,
        revisionVersion: anotherDraft.version,
      });
    await admin
      .post(
        `/api/management/projects/system/clients/${another.body.client.clientId}/disable`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ clientVersion: anotherPending.body.client.clientVersion });
    const blocked = await admin
      .post(
        `/api/management/admin/projects/system/clients/${another.body.client.clientId}/revisions/${anotherPending.body.client.proposedRevision.revisionId}/approve`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        revisionId: anotherPending.body.client.proposedRevision.revisionId,
        revisionVersion: anotherPending.body.client.proposedRevision.version,
      });
    assert.equal(blocked.status, 409);
  } finally {
    await state.close();
  }
});

test("management API rotates secrets and isolates authorization revocation", async () => {
  const { app, state } = await createApp();
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const created = await admin
      .post("/api/management/projects/system/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send(input);
    const clientId = created.body.client.clientId as string;
    assert.equal(created.body.client.secrets.length, 1);
    assert.equal("secretDigest" in created.body.client.secrets[0], false);

    const missingCsrf = await admin
      .post(
        `/api/management/projects/system/clients/${clientId}/secrets/rotate`,
      )
      .send({ clientVersion: created.body.client.clientVersion });
    assert.equal(missingCsrf.status, 400);

    const digestSubmission = await admin
      .post(
        `/api/management/projects/system/clients/${clientId}/secrets/rotate`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: created.body.client.clientVersion,
        clientSecretDigest: "scrypt$submitted",
      });
    assert.equal(digestSubmission.status, 400);

    const outsider = request.agent(app);
    const outsiderLogin = await login(outsider, "secret-outsider");
    const denied = await outsider
      .post(
        `/api/management/projects/system/clients/${clientId}/secrets/rotate`,
      )
      .set("X-CSRF-Token", outsiderLogin.body.csrfToken)
      .send({ clientVersion: created.body.client.clientVersion });
    assert.equal(denied.status, 404);

    const rotated = await admin
      .post(
        `/api/management/projects/system/clients/${clientId}/secrets/rotate`,
      )
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
        `/api/management/projects/system/clients/${clientId}/secrets/${retiring.secretId}/revoke`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: created.body.client.clientVersion,
        secretVersion: retiring.version,
      });
    assert.equal(stale.status, 409);
    const revoked = await admin
      .post(
        `/api/management/projects/system/clients/${clientId}/secrets/${retiring.secretId}/revoke`,
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

    await state.persistence.artifacts.upsertArtifact(
      "Grant:owned",
      "Grant",
      { clientId, value: "owned" },
      120,
    );
    await state.persistence.artifacts.upsertArtifact(
      "Grant:other",
      "Grant",
      { clientId: "bootstrap-site", value: "other" },
      120,
    );
    await state.persistence.artifacts.upsertArtifact(
      "Session:shared",
      "Session",
      { clientId, value: "session" },
      120,
    );
    const authorizations = await admin
      .post(
        `/api/management/projects/system/clients/${clientId}/authorizations/revoke`,
      )
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ clientVersion: revoked.body.client.clientVersion });
    assert.equal(authorizations.status, 200);
    assert.equal(
      await state.persistence.artifacts.findArtifact("Grant:owned"),
      undefined,
    );
    assert.ok(await state.persistence.artifacts.findArtifact("Grant:other"));
    assert.ok(await state.persistence.artifacts.findArtifact("Session:shared"));

    const disabled = await admin
      .post(`/api/management/projects/system/clients/${clientId}/disable`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ clientVersion: authorizations.body.client.clientVersion });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.client.lifecycleStatus, "disabled");
    assert.ok(
      disabled.body.client.secrets.every(
        (secret: { status: string }) => secret.status === "revoked",
      ),
    );
    const audits =
      await state.persistence.clients.listOidcClientAuditLogs(clientId);
    assert.equal(
      JSON.stringify(audits).includes(rotated.body.secret.value),
      false,
    );
    assert.equal(JSON.stringify(audits).includes("scrypt$"), false);
  } finally {
    await state.close();
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
      .post("/api/management/projects/system/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send(input);
    const path = `/api/management/projects/system/clients/${created.body.client.clientId}/secrets/rotate`;
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
    await state.close();
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
          .post("/api/management/projects/system/clients")
          .set("X-CSRF-Token", signedIn.body.csrfToken)
          .send(input)
      ).status,
      201,
    );
    const limited = await admin
      .post("/api/management/projects/system/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send(input);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers["retry-after"]);
  } finally {
    await state.close();
  }
});

test("management API rate limits project creation by subject", async () => {
  const { app, state } = await createApp({
    OIDC_MANAGEMENT_PROJECT_QUOTA_ADMIN_EXEMPT: "false",
    OIDC_MANAGEMENT_PROJECT_MAX_ACTIVE_PER_SUBJECT: "10",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_SUBJECT_MAX: "1",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_IP_MAX: "10",
  });
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    assert.equal(
      (
        await admin
          .post("/api/management/projects")
          .set("X-CSRF-Token", signedIn.body.csrfToken)
          .send({ name: "First project", description: "" })
      ).status,
      201,
    );
    const limited = await admin
      .post("/api/management/projects")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ name: "Second project", description: "" });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers["retry-after"]);
  } finally {
    await state.close();
  }
});

test("management API rate limits project creation by source IP", async () => {
  const { app, state } = await createApp({
    OIDC_MANAGEMENT_PROJECT_QUOTA_ADMIN_EXEMPT: "false",
    OIDC_MANAGEMENT_PROJECT_MAX_ACTIVE_PER_SUBJECT: "10",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_SUBJECT_MAX: "5",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_IP_MAX: "1",
  });
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    assert.equal(
      (
        await admin
          .post("/api/management/projects")
          .set("X-CSRF-Token", signedIn.body.csrfToken)
          .send({ name: "First project", description: "" })
      ).status,
      201,
    );
    const limited = await admin
      .post("/api/management/projects")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ name: "Second project", description: "" });
    assert.equal(limited.status, 429);
  } finally {
    await state.close();
  }
});

test("management API enforces active project quota", async () => {
  const { app, state } = await createApp({
    OIDC_MANAGEMENT_PROJECT_QUOTA_ADMIN_EXEMPT: "false",
    OIDC_MANAGEMENT_PROJECT_MAX_ACTIVE_PER_SUBJECT: "1",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_SUBJECT_MAX: "5",
    OIDC_MANAGEMENT_PROJECT_CREATE_RATE_LIMIT_IP_MAX: "5",
  });
  await seedAdmin(state);
  try {
    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    assert.equal(
      (
        await admin
          .post("/api/management/projects")
          .set("X-CSRF-Token", signedIn.body.csrfToken)
          .send({ name: "Only project", description: "" })
      ).status,
      201,
    );
    const limited = await admin
      .post("/api/management/projects")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({ name: "Too many", description: "" });
    assert.equal(limited.status, 409);
    assert.equal(limited.body.error, "project_quota_exceeded");
  } finally {
    await state.close();
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
          .post("/api/management/projects/system/clients")
          .set("X-CSRF-Token", signedIn.body.csrfToken)
          .send(input)
      ).status,
      201,
    );
    const limited = await admin
      .post("/api/management/projects/system/clients")
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send(input);
    assert.equal(limited.status, 429);
  } finally {
    await state.close();
  }
});

test("legacy email settings API has been removed", async () => {
  const { app, state } = await createApp();
  try {
    for (const path of [
      "/api/management/settings/email",
      "/api/management/settings/email/audit-logs",
      "/api/management/settings/email/test",
    ]) {
      assert.equal((await request(app).get(path)).status, 404);
    }
  } finally {
    await state.close();
  }
});

test("runtime policy restart is admin-only and runs after the response", async () => {
  let restartRequests = 0;
  const { app, state } = await createApp(
    {},
    {
      requestRestart: () => {
        restartRequests += 1;
      },
    },
  );
  await seedAdmin(state);
  try {
    const outsider = request.agent(app);
    const outsiderLogin = await login(outsider, "restart-outsider");
    const denied = await outsider
      .post("/api/management/settings/runtime-policy/restart")
      .set("X-CSRF-Token", outsiderLogin.body.csrfToken);
    assert.equal(denied.status, 403);
    assert.equal(restartRequests, 0);

    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const accepted = await admin
      .post("/api/management/settings/runtime-policy/restart")
      .set("X-CSRF-Token", signedIn.body.csrfToken);
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body, { restarting: true });
    assert.equal(restartRequests, 1);
  } finally {
    await state.close();
  }
});

test("liveness does not depend on dynamic client CSP lookup", async () => {
  const { app, state } = await createApp();
  state.persistence.clients.listActiveOidcClients = async () => {
    throw new Error("database unavailable");
  };
  try {
    assert.deepEqual((await request(app).get("/health/live")).body, {
      status: "live",
    });
  } finally {
    await state.close();
  }
});
