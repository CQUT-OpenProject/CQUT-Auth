import { test } from "vite-plus/test";
import {
  assert,
  createApp,
  input,
  login,
  request,
  seedAdmin,
} from "./management-api.helpers.js";

test("management API activates clients and revisions immediately", async () => {
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
    assert.equal(created.body.client.lifecycleStatus, "active");
    assert.equal(created.body.client.activeRevision.status, "approved");
    assert.equal(created.body.client.proposedRevision, null);
    assert.equal(typeof created.body.clientSecret, "string");
    assert.equal("clientSecretDigest" in created.body.client, false);

    const clientId = created.body.client.clientId;
    const typeChange = await admin
      .patch(`/api/management/projects/system/clients/${clientId}`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        clientVersion: created.body.client.clientVersion,
        clientType: "spa",
      });
    assert.equal(typeChange.status, 400);

    const authorize = {
      client_id: clientId,
      response_type: "code",
      scope: "openid profile",
      state: "revision-state",
      nonce: "revision-nonce",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
    };
    const firstLive = await request(app)
      .get("/auth")
      .query({ ...authorize, redirect_uri: input.redirectUris[0] });
    assert.ok(firstLive.status === 302 || firstLive.status === 303);

    const updated = await admin
      .put(`/api/management/projects/system/clients/${clientId}/revision`)
      .set("X-CSRF-Token", signedIn.body.csrfToken)
      .send({
        redirectUris: ["http://localhost:3004/new-callback"],
        scopeWhitelist: ["openid", "profile", "email"],
      });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.client.proposedRevision, null);
    assert.deepEqual(updated.body.client.activeRevision.redirectUris, [
      "http://localhost:3004/new-callback",
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
    await login(outsider, "other-account");
    assert.equal(
      (
        await outsider.get(
          `/api/management/projects/system/clients/${clientId}`,
        )
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
