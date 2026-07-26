import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { ManagementSessionService } from "../src/management/management-session.service.js";
import { createPersistence } from "../src/persistence/persistence.js";
import { sha256 } from "../src/utils.js";

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
