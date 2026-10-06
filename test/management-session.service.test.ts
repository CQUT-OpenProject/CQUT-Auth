import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { readConfig } from "../src/config.js";
import { ManagementSessionService } from "../src/management/management-session.service.js";
import { createPersistence } from "../src/persistence/persistence.js";
import { sha256 } from "../src/utils.js";
import { ManagementSessionRepositoryImpl } from "../src/persistence/management-session.repository.js";

test("login does not synchronously sweep expired sessions", async () => {
  const sessions = new ManagementSessionRepositoryImpl(() => undefined);
  const cleanup = vi.spyOn(sessions, "deleteExpiredManagementSessions");
  const service = new ManagementSessionService(
    sessions,
    { findPrincipalBySubjectId: async () => null },
    3600,
    60,
  );
  await service.create("synthetic-subject");
  assert.equal(cleanup.mock.calls.length, 0);
});

test("session cleanup bounds each batch and preserves active sessions", async () => {
  const sessions = new ManagementSessionRepositoryImpl(() => undefined);
  for (let i = 0; i < 3; i++) {
    await sessions.createManagementSession({
      tokenHash: `synthetic-hash-${i}`,
      subjectId: "synthetic-subject",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      expiresAt:
        i < 2 ? "2026-01-01T00:01:00.000Z" : "2026-01-02T00:00:00.000Z",
    });
  }
  const now = "2026-01-01T01:00:00.000Z";
  assert.equal(await sessions.deleteExpiredManagementSessions(now, 1), 1);
  assert.equal(await sessions.deleteExpiredManagementSessions(now, 1), 1);
  assert.equal(await sessions.deleteExpiredManagementSessions(now, 1), 0);
  assert.ok(await sessions.findManagementSession("synthetic-hash-2"));
});

test("persistence schedules session cleanup and stops it on close", async () => {
  vi.useFakeTimers();
  const modules = await createPersistence(
    readConfig({
      APP_ENV: "test",
      AUTH_PROVIDER: "mock",
      OIDC_KEY_ENCRYPTION_SECRET: "test-session-key",
      OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-session-artifact",
    }),
  );
  const cleanup = vi.spyOn(modules.sessions, "deleteExpiredManagementSessions");
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(cleanup.mock.calls.length, 1);
    await modules.runtime.close();
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(cleanup.mock.calls.length, 1);
  } finally {
    await modules.runtime.close();
    vi.useRealTimers();
  }
});

test("management sessions persist only a token hash and expire on idle timeout", async () => {
  const modules = await createPersistence(
    readConfig({
      APP_ENV: "test",
      AUTH_PROVIDER: "mock",
      OIDC_KEY_ENCRYPTION_SECRET: "test-session-key",
      OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-session-artifact",
    }),
  );
  let now = new Date("2026-01-01T00:00:00.000Z");
  try {
    await modules.identity.createSubjectWithIdentity(
      {
        subjectId: "subj_session",
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        subjectId: "subj_session",
        provider: "mock",
        schoolUid: "session-user",
        identityKey: "mock:session-user",
        currentStudentStatus: "active",
        school: "cqut",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    );
    const sessions = new ManagementSessionService(
      modules.sessions,
      modules.identity,
      3600,
      60,
      () => now,
      () => "raw-browser-token",
    );
    const created = await sessions.create("subj_session");
    assert.equal(created.token, "raw-browser-token");
    assert.equal(
      await modules.sessions.findManagementSession("raw-browser-token"),
      null,
    );
    assert.equal(
      (
        await modules.sessions.findManagementSession(
          sha256("raw-browser-token"),
        )
      )?.subjectId,
      "subj_session",
    );
    assert.equal(
      (await sessions.authenticate("raw-browser-token"))?.subjectId,
      "subj_session",
    );

    now = new Date("2026-01-01T00:01:01.000Z");
    assert.equal(await sessions.authenticate("raw-browser-token"), null);
    assert.equal(
      await modules.sessions.findManagementSession(sha256("raw-browser-token")),
      null,
    );
  } finally {
    await modules.runtime.close();
  }
});

test("management session create revokes prior sessions for the same subject", async () => {
  const modules = await createPersistence(
    readConfig({
      APP_ENV: "test",
      AUTH_PROVIDER: "mock",
      OIDC_KEY_ENCRYPTION_SECRET: "test-session-key",
      OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-session-artifact",
    }),
  );
  let now = new Date("2026-01-01T00:00:00.000Z");
  try {
    await modules.identity.createSubjectWithIdentity(
      {
        subjectId: "subj_relogin",
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      {
        subjectId: "subj_relogin",
        provider: "mock",
        schoolUid: "relogin-user",
        identityKey: "mock:relogin-user",
        currentStudentStatus: "active",
        school: "cqut",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    );
    let tokenCounter = 0;
    const sessions = new ManagementSessionService(
      modules.sessions,
      modules.identity,
      3600,
      3600,
      () => now,
      () => `session-token-${++tokenCounter}`,
    );
    const first = await sessions.create("subj_relogin");
    const second = await sessions.create("subj_relogin");
    assert.equal(await sessions.authenticate(first.token), null);
    assert.equal(
      (await sessions.authenticate(second.token))?.subjectId,
      "subj_relogin",
    );
  } finally {
    await modules.runtime.close();
  }
});
