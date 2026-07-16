import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { createClientSecretDigest } from "../src/crypto.js";
import { PersistenceRuntimeImpl } from "../src/persistence/persistence.js";

test("persistence modules preserve the memory-mode contract", async () => {
  const config = readConfig({
    APP_ENV: "test",
    AUTH_PROVIDER: "mock",
    OIDC_COOKIE_SECURE: "false",
    OIDC_ISSUER: "http://127.0.0.1:3003",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
  });
  const persistence = new PersistenceRuntimeImpl(config);
  await persistence.init();

  assert.equal(persistence.hasDatabase(), false);
  assert.equal(await persistence.checkReadiness(), true);

  const now = new Date().toISOString();
  await persistence.createSubjectWithIdentity(
    {
      subjectId: "subj_demo",
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    {
      subjectId: "subj_demo",
      provider: "mock",
      schoolUid: "20240001",
      identityKey: "cqut:20240001",
      currentStudentStatus: "active",
      school: "cqut",
      createdAt: now,
      updatedAt: now,
    },
  );

  const identity = await persistence.findIdentity("mock", "cqut:20240001");
  assert.equal(identity?.schoolUid, "20240001");

  await persistence.upsertProfile({
    subjectId: "subj_demo",
    preferredUsername: "20240001",
    displayName: "CQUT User 20240001",
    email: "demo@example.com",
    emailVerified: false,
    updatedAt: now,
  });
  const principal = await persistence.findPrincipalBySubjectId("subj_demo");
  assert.equal(principal?.preferredUsername, "20240001");

  await persistence.upsertOidcClient({
    clientId: "demo-site",
    clientSecretDigests: [
      await createClientSecretDigest("test-oidc-demo-client-secret"),
    ],
    displayName: "Demo Site",
    description: "",
    projectId: "system",
    createdBySubjectId: "subj_demo",
    clientType: "web",
    lifecycleStatus: "active",
    activeRevisionId: 1,
    authorizationGeneration: 1,
    activeRevision: {
      revisionId: 1,
      clientId: "demo-site",
      revisionNumber: 1,
      status: "approved",
      redirectUris: ["http://localhost:3002/demo/callback"],
      postLogoutRedirectUris: ["http://localhost:3002/demo"],
      scopeWhitelist: [
        "openid",
        "profile",
        "email",
        "student",
        "offline_access",
      ],
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    applicationType: "web",
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris: ["http://localhost:3002/demo/callback"],
    postLogoutRedirectUris: ["http://localhost:3002/demo"],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopeWhitelist: ["openid", "profile", "email", "student", "offline_access"],
    requirePkce: true,
    allowRefreshTokenForPublicClient: false,
    autoConsent: true,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
  const clients = await persistence.listActiveOidcClients();
  assert.equal(clients.length, 1);
  assert.equal(clients[0]?.clientId, "demo-site");
  assert.equal(clients[0]?.allowRefreshTokenForPublicClient, false);

  let releaseLateIssue!: () => void;
  const revocationCommitted = new Promise<void>((resolve) => {
    releaseLateIssue = resolve;
  });
  const lateIssue = (async () => {
    await revocationCommitted;
    await persistence.upsertArtifact(
      "AccessToken:late-token",
      "AccessToken",
      { clientId: "demo-site", accountId: "subj_demo" },
      120,
      1,
    );
  })();
  const afterRevocation = await persistence.revokeOidcClientAuthorizations(
    "demo-site",
    1,
    now,
    {
      clientId: "demo-site",
      actorSubjectId: "subj_demo",
      action: "client.authorizations_revoked",
      changedFields: ["authorizations"],
      createdAt: now,
    },
    {
      actor: { subjectId: "subj_demo", isAdmin: true },
      projectId: "system",
      action: "revoke_authorizations",
    },
  );
  assert.ok(afterRevocation);
  releaseLateIssue();
  await lateIssue;
  assert.equal(
    await persistence.findArtifact("AccessToken:late-token"),
    undefined,
  );
  await persistence.upsertArtifact(
    "AccessToken:new-generation",
    "AccessToken",
    { clientId: "demo-site", accountId: "subj_demo" },
    120,
  );
  assert.ok(await persistence.findArtifact("AccessToken:new-generation"));
  const disabled = await persistence.disableOidcClient(
    "demo-site",
    afterRevocation!.client.version,
    now,
    [
      {
        clientId: "demo-site",
        actorSubjectId: "subj_demo",
        action: "client.emergency_disabled",
        changedFields: ["lifecycleStatus", "authorizations"],
        createdAt: now,
      },
    ],
    {
      actor: { subjectId: "subj_demo", isAdmin: true },
      projectId: "system",
      action: "disable_client",
    },
  );
  assert.ok(disabled);
  assert.equal(
    await persistence.findArtifact("AccessToken:new-generation"),
    undefined,
  );
  await persistence.upsertArtifact(
    "AccessToken:after-disable",
    "AccessToken",
    { clientId: "demo-site", accountId: "subj_demo" },
    120,
    2,
  );
  assert.equal(
    await persistence.findArtifact("AccessToken:after-disable"),
    undefined,
  );

  await persistence.upsertArtifact(
    "AuthorizationCode:code-1",
    "AuthorizationCode",
    {
      uid: "uid-1",
      userCode: "uc-1",
      grantId: "grant-1",
      accountId: "subj_demo",
      value: "ok",
    },
    120,
  );
  await persistence.upsertArtifact(
    "Session:session-1",
    "Session",
    {
      uid: "uid-1",
      accountId: "subj_demo",
      value: "session-payload",
    },
    120,
  );
  const artifact = await persistence.findArtifact("AuthorizationCode:code-1");
  assert.equal(artifact?.["value"], "ok");
  assert.equal((await persistence.findArtifactByUid("uid-1"))?.["value"], "ok");
  assert.equal(
    (await persistence.findArtifactByUid("uid-1", "AuthorizationCode"))?.[
      "value"
    ],
    "ok",
  );
  assert.equal(
    (await persistence.findArtifactByUid("uid-1", "Session"))?.["value"],
    "session-payload",
  );
  assert.equal(
    (await persistence.findArtifactByUserCode("uc-1"))?.["value"],
    "ok",
  );
  await persistence.consumeArtifact("AuthorizationCode:code-1");
  const consumed = await persistence.findArtifact("AuthorizationCode:code-1");
  assert.equal(typeof consumed?.["consumed"], "number");
  await persistence.revokeArtifactsByGrantId("grant-1");
  assert.equal(
    await persistence.findArtifact("AuthorizationCode:code-1"),
    undefined,
  );

  await persistence.saveInteractionLogin("uid-login", {
    principal: principal!,
    authTime: Math.floor(Date.now() / 1000),
  });
  assert.ok(await persistence.getInteractionLogin("uid-login"));
  await persistence.deleteInteractionLogin("uid-login");
  assert.equal(await persistence.getInteractionLogin("uid-login"), undefined);

  const encryptedPrivate = await persistence.encryptPrivateJwk({
    kty: "RSA",
    n: "n",
    e: "AQAB",
    d: "d",
  });
  await persistence.upsertSigningKey({
    kid: "kid-1",
    alg: "RS256",
    use: "sig",
    publicJwk: {
      kty: "RSA",
      n: "n",
      e: "AQAB",
    } as JsonWebKey,
    privateJwkCiphertext: encryptedPrivate,
    status: "active",
    createdAt: now,
    activatedAt: now,
  });
  const signingKeys = await persistence.listSigningKeys(["active"]);
  assert.equal(signingKeys.length, 1);
  const jwks = await persistence.loadPrivateSigningJwks(["active"]);
  assert.equal(jwks.length, 1);
  assert.equal(jwks[0]?.kid, "kid-1");

  await persistence.close();
});
