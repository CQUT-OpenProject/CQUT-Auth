import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import { ArtifactPayloadCipherServiceImpl } from "../src/persistence/artifact-payload-cipher.service.js";
import { OidcArtifactRepositoryImpl } from "../src/persistence/oidc-artifact.repository.js";

const TEST_ARTIFACT_SECRET = "test-oidc-artifact-secret";

function lookupHash(value: string) {
  return createHmac("sha256", TEST_ARTIFACT_SECRET).update(value).digest("hex");
}

type FakeQueryResult = {
  rows?: Record<string, unknown>[];
  rowCount?: number;
};

class FakePool {
  readonly calls: Array<{ sql: string; values: unknown[] | undefined }> = [];

  constructor(
    private readonly responder: (
      sql: string,
      values: unknown[] | undefined,
    ) => FakeQueryResult,
  ) {}

  async query(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    const result = this.responder(sql, values);
    return {
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? (result.rows ? result.rows.length : 0),
    };
  }
}

function createRepository(pool: FakePool) {
  const cipher = new ArtifactPayloadCipherServiceImpl(TEST_ARTIFACT_SECRET);
  return new OidcArtifactRepositoryImpl(
    () => pool as unknown as Pool,
    900,
    {
      enabled: false,
      sampleRate: 0,
      batchSize: 100,
      minIntervalSeconds: 30,
    },
    cipher,
  );
}

function createInMemoryRepository() {
  const cipher = new ArtifactPayloadCipherServiceImpl(TEST_ARTIFACT_SECRET);
  return new OidcArtifactRepositoryImpl(
    () => undefined,
    900,
    {
      enabled: false,
      sampleRate: 0,
      batchSize: 100,
      minIntervalSeconds: 30,
    },
    cipher,
  );
}

test("upsertArtifact stores encrypted envelope instead of plaintext payload", async () => {
  const pool = new FakePool(() => ({ rowCount: 1 }));
  const repository = createRepository(pool);

  await repository.upsertArtifact(
    "AuthorizationCode:code-1",
    "AuthorizationCode",
    {
      uid: "uid-1",
      grantId: "grant-1",
      clientId: "client-a",
      value: "top-secret",
    },
    120,
  );

  const insertCall = pool.calls.find((call) =>
    call.sql.includes("insert into oidc_artifacts"),
  );
  assert.ok(insertCall);
  assert.equal(insertCall.values?.[2], lookupHash("grant-1"));
  assert.equal(insertCall.values?.[3], lookupHash("client-a"));
  assert.equal(insertCall.values?.[4], 1);
  assert.equal(insertCall.values?.[5], lookupHash("uid-1"));
  assert.equal(insertCall.values?.[6], null);
  const serializedPayload = insertCall.values?.[7];
  assert.equal(typeof serializedPayload, "string");
  const payload = JSON.parse(serializedPayload as string) as Record<
    string,
    unknown
  >;

  assert.equal(payload["version"], 1);
  assert.equal(typeof payload["ciphertext"], "string");
  assert.equal(
    (payload["ciphertext"] as string).startsWith("v2$scrypt$"),
    false,
  );
  assert.equal((payload["ciphertext"] as string).includes("top-secret"), false);
  assert.equal((payload["ciphertext"] as string).includes("uid-1"), false);
});

test("revokeArtifactsByClientId deletes only revocable artifacts for one client", async () => {
  const repository = createInMemoryRepository();
  for (const kind of [
    "AuthorizationCode",
    "AccessToken",
    "RefreshToken",
    "Grant",
    "Session",
  ]) {
    await repository.upsertArtifact(
      `${kind}:a`,
      kind,
      { clientId: "client-a", value: kind },
      120,
    );
    await repository.upsertArtifact(
      `${kind}:b`,
      kind,
      { clientId: "client-b", value: kind },
      120,
    );
  }

  await repository.revokeArtifactsByClientId("client-a");

  for (const kind of [
    "AuthorizationCode",
    "AccessToken",
    "RefreshToken",
    "Grant",
  ]) {
    assert.equal(await repository.findArtifact(`${kind}:a`), undefined);
    assert.ok(await repository.findArtifact(`${kind}:b`));
  }
  assert.ok(await repository.findArtifact("Session:a"));
  assert.ok(await repository.findArtifact("Session:b"));
});

test("findArtifact decrypts encrypted envelope from database", async () => {
  const cipher = new ArtifactPayloadCipherServiceImpl(TEST_ARTIFACT_SECRET);
  const encryptedPayload = {
    version: 1,
    ciphertext: await cipher.encryptPayload({
      uid: "uid-1",
      value: "ok",
    }),
  };

  const pool = new FakePool((sql) => {
    if (sql.includes("where id = $1")) {
      return {
        rows: [
          {
            id: "AuthorizationCode:code-1",
            kind: "AuthorizationCode",
            grant_id_hash: lookupHash("grant-1"),
            uid_hash: lookupHash("uid-1"),
            user_code_hash: null,
            payload: encryptedPayload,
            expires_at: new Date(Date.now() + 60_000),
            consumed_at: null,
            created_at: new Date(),
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = createRepository(pool);

  const artifact = await repository.findArtifact("AuthorizationCode:code-1");
  assert.equal(artifact?.["value"], "ok");
  assert.equal(artifact?.["uid"], "uid-1");
});

test("findArtifact returns undefined for invalid payload envelope", async () => {
  const pool = new FakePool((sql) => {
    if (sql.includes("where id = $1")) {
      return {
        rows: [
          {
            id: "AuthorizationCode:legacy-1",
            kind: "AuthorizationCode",
            grant_id_hash: null,
            uid_hash: lookupHash("uid-legacy"),
            user_code_hash: null,
            payload: {
              uid: "uid-legacy",
              value: "plaintext",
            },
            expires_at: new Date(Date.now() + 60_000),
            consumed_at: null,
            created_at: new Date(),
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = createRepository(pool);

  const artifact = await repository.findArtifact("AuthorizationCode:legacy-1");
  assert.equal(artifact, undefined);
});

test("findArtifactByUid includes kind filter when provided", async () => {
  const cipher = new ArtifactPayloadCipherServiceImpl(TEST_ARTIFACT_SECRET);
  const encryptedPayload = {
    version: 1,
    ciphertext: await cipher.encryptPayload({
      kind: "Session",
      uid: "shared-uid",
      value: "session-payload",
    }),
  };

  const pool = new FakePool((sql, values) => {
    if (sql.includes("where uid_hash = $1")) {
      assert.match(sql, /and kind = \$2/);
      assert.equal(values?.[0], lookupHash("shared-uid"));
      assert.equal(values?.[1], "Session");
      return {
        rows: [
          {
            id: "Session:session-1",
            kind: "Session",
            grant_id_hash: null,
            uid_hash: lookupHash("shared-uid"),
            user_code_hash: null,
            payload: encryptedPayload,
            expires_at: new Date(Date.now() + 60_000),
            consumed_at: null,
            created_at: new Date(),
          },
        ],
      };
    }
    return { rows: [] };
  });
  const repository = createRepository(pool);

  const artifact = await repository.findArtifactByUid("shared-uid", "Session");

  assert.equal(artifact?.["value"], "session-payload");
});

test("findArtifactByUid applies kind filter in memory mode", async () => {
  const repository = createInMemoryRepository();
  await repository.upsertArtifact(
    "AuthorizationCode:code-1",
    "AuthorizationCode",
    {
      uid: "shared-uid",
      value: "code-payload",
    },
    120,
  );
  await repository.upsertArtifact(
    "Session:session-1",
    "Session",
    {
      uid: "shared-uid",
      value: "session-payload",
    },
    120,
  );

  assert.equal(
    (await repository.findArtifactByUid("shared-uid", "AuthorizationCode"))?.[
      "value"
    ],
    "code-payload",
  );
  assert.equal(
    (await repository.findArtifactByUid("shared-uid", "Session"))?.["value"],
    "session-payload",
  );
});

test("consumeArtifact allows only one consumer in memory mode", async () => {
  const repository = createInMemoryRepository();
  await repository.upsertArtifact(
    "AuthorizationCode:single-use",
    "AuthorizationCode",
    { value: "code" },
    120,
  );

  const attempts = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      repository.consumeArtifact("AuthorizationCode:single-use"),
    ),
  );

  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    19,
  );
});

test("consumeArtifact rejects when the database update loses the race", async () => {
  const pool = new FakePool((sql) => ({
    rowCount: sql.includes("update oidc_artifacts") ? 0 : 1,
  }));
  const repository = createRepository(pool);

  await assert.rejects(
    repository.consumeArtifact("RefreshToken:already-consumed"),
    (error: unknown) =>
      error instanceof Error && error.message === "invalid_grant",
  );
});

test("email verification counts concurrent attempts atomically", async () => {
  const repository = createInMemoryRepository();
  await repository.saveInteractionLogin("interaction-1", {
    principal: {
      subjectId: "subject-1",
      schoolUid: "student-1",
      school: "cqut",
      studentStatus: "active",
      identitySource: "mock",
      identityKey: "mock:student-1",
      emailVerified: false,
      preferredUsername: "student-1",
    },
    authTime: 1,
    emailVerification: {
      email: "target@example.com",
      codeHash: "correct-hash",
      expiresAt: 10_000,
      attempts: 0,
      nextResendAt: 2_000,
    },
  });

  const attempts = await Promise.all(
    Array.from({ length: 20 }, () =>
      repository.verifyInteractionEmailCode(
        "interaction-1",
        "correct-hash",
        "wrong-hash",
        1_000,
        5,
      ),
    ),
  );

  assert.equal(
    attempts.filter((attempt) => attempt.status === "incorrect").length,
    4,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "locked").length,
    1,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "missing").length,
    15,
  );
  assert.equal(
    (await repository.getInteractionLogin("interaction-1"))?.emailVerification,
    undefined,
  );
});

test("email verification accepts a concurrent correct code only once", async () => {
  const repository = createInMemoryRepository();
  await repository.saveInteractionLogin("interaction-2", {
    principal: {
      subjectId: "subject-2",
      schoolUid: "student-2",
      school: "cqut",
      studentStatus: "active",
      identitySource: "mock",
      identityKey: "mock:student-2",
      emailVerified: false,
      preferredUsername: "student-2",
    },
    authTime: 1,
    emailVerification: {
      email: "target@example.com",
      codeHash: "correct-hash",
      expiresAt: 10_000,
      attempts: 0,
      nextResendAt: 2_000,
    },
  });

  const attempts = await Promise.all(
    Array.from({ length: 20 }, () =>
      repository.verifyInteractionEmailCode(
        "interaction-2",
        "correct-hash",
        "correct-hash",
        1_000,
        5,
      ),
    ),
  );

  assert.equal(
    attempts.filter((attempt) => attempt.status === "verified").length,
    1,
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === "missing").length,
    19,
  );
});
