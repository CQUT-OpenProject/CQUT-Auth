import assert from "node:assert/strict";
import test from "node:test";
import {
  ClientManagementService,
  ClientManagementError,
} from "../src/clients/client-management.service.js";
import { readOidcOpConfig } from "../src/config.js";
import { OidcPersistenceImpl } from "../src/persistence/persistence.js";
import { ProjectManagementService } from "../src/projects/project-management.service.js";

const owner = { subjectId: "subj_project_owner", isAdmin: false };
const maintainer = { subjectId: "subj_project_maintainer", isAdmin: false };
const viewer = { subjectId: "subj_project_viewer", isAdmin: false };
const outsider = { subjectId: "subj_project_outsider", isAdmin: false };

async function fixture() {
  const store = new OidcPersistenceImpl(
    readOidcOpConfig({
      APP_ENV: "test",
      AUTH_PROVIDER: "mock",
      OIDC_KEY_ENCRYPTION_SECRET: "project-test-key",
      OIDC_ARTIFACT_ENCRYPTION_SECRET: "project-test-artifact",
    }),
  );
  await store.init();
  const now = new Date().toISOString();
  for (const actor of [owner, maintainer, viewer, outsider]) {
    await store.createSubjectWithIdentity(
      {
        subjectId: actor.subjectId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        subjectId: actor.subjectId,
        provider: "mock",
        schoolUid: actor.subjectId,
        identityKey: `mock:${actor.subjectId}`,
        currentStudentStatus: "active",
        school: "cqut",
        createdAt: now,
        updatedAt: now,
      },
    );
  }
  const projects = new ProjectManagementService(
    store,
    () => new Date(),
    () => "project_test",
  );
  const clients = new ClientManagementService(store, projects.access, "test", {
    createClientId: () => "project_client",
    createSecret: () => "single-use-secret",
  });
  const project = await projects.create(owner, {
    name: "Project Test",
    description: "",
  });
  return { store, projects, clients, project };
}

test("project roles authorize clients and removed members lose access immediately", async () => {
  const { store, projects, clients, project: initial } = await fixture();
  try {
    let project = await projects.addMember(owner, initial.projectId, {
      subjectId: maintainer.subjectId,
      role: "maintainer",
      expectedProjectVersion: initial.version,
    });
    project = await projects.addMember(owner, initial.projectId, {
      subjectId: viewer.subjectId,
      role: "viewer",
      expectedProjectVersion: project.version,
    });
    const created = await clients.create(maintainer, initial.projectId, {
      clientType: "web",
      displayName: "Team client",
      description: "",
      redirectUris: ["http://localhost:3002/callback"],
      postLogoutRedirectUris: [],
      scopeWhitelist: ["openid", "profile"],
    });
    assert.equal(
      (await clients.get(viewer, initial.projectId, created.client.clientId))
        .clientId,
      created.client.clientId,
    );
    await assert.rejects(
      () =>
        clients.create(viewer, initial.projectId, {
          clientType: "spa",
          displayName: "Forbidden",
          description: "",
          redirectUris: ["http://localhost:3002/forbidden"],
          postLogoutRedirectUris: [],
          scopeWhitelist: ["openid"],
        }),
      (error: unknown) =>
        error instanceof ClientManagementError && error.status === 403,
    );
    await assert.rejects(
      () => clients.get(outsider, initial.projectId, created.client.clientId),
      (error: unknown) =>
        error instanceof ClientManagementError && error.status === 404,
    );
    project = await projects.removeMember(
      owner,
      initial.projectId,
      maintainer.subjectId,
      {
        expectedProjectVersion: project.version,
      },
    );
    await assert.rejects(
      () => clients.get(maintainer, initial.projectId, created.client.clientId),
      (error: unknown) =>
        error instanceof ClientManagementError && error.status === 404,
    );
    const audit = await projects.audits(owner, initial.projectId, 100);
    assert.ok(
      audit.some((entry) => entry.action === "client.secret_generated"),
    );
    assert.equal(JSON.stringify(audit).includes("single-use-secret"), false);
    assert.equal(JSON.stringify(audit).includes("scrypt$"), false);
    assert.ok(project.version > initial.version);
  } finally {
    await store.close();
  }
});

test("project owner protection, optimistic concurrency, and transfer are atomic", async () => {
  const { store, projects, project: initial } = await fixture();
  try {
    await assert.rejects(
      () =>
        projects.removeMember(owner, initial.projectId, owner.subjectId, {
          expectedProjectVersion: initial.version,
        }),
      (error: unknown) =>
        error instanceof ClientManagementError &&
        error.code === "last_owner_required",
    );
    let project = await projects.addMember(owner, initial.projectId, {
      subjectId: maintainer.subjectId,
      role: "maintainer",
      expectedProjectVersion: initial.version,
    });
    const concurrent = await Promise.allSettled([
      projects.updateMember(owner, initial.projectId, maintainer.subjectId, {
        role: "viewer",
        expectedProjectVersion: project.version,
      }),
      projects.updateMember(owner, initial.projectId, maintainer.subjectId, {
        role: "owner",
        expectedProjectVersion: project.version,
      }),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1,
    );
    project = await projects.get(owner, initial.projectId);
    const members = await projects.members(owner, initial.projectId);
    if (
      members.find((member) => member.subjectId === maintainer.subjectId)
        ?.role !== "maintainer"
    ) {
      project = await projects.updateMember(
        owner,
        initial.projectId,
        maintainer.subjectId,
        {
          role: "maintainer",
          expectedProjectVersion: project.version,
        },
      );
    }
    project = await projects.transfer(owner, initial.projectId, {
      fromSubjectId: owner.subjectId,
      toSubjectId: maintainer.subjectId,
      expectedProjectVersion: project.version,
    });
    const transferred = await projects.members(maintainer, initial.projectId);
    assert.equal(
      transferred.find((member) => member.subjectId === owner.subjectId)?.role,
      "maintainer",
    );
    assert.equal(
      transferred.find((member) => member.subjectId === maintainer.subjectId)
        ?.role,
      "owner",
    );
    const audits = await projects.audits(maintainer, initial.projectId, 100);
    assert.ok(
      audits.some((entry) => entry.action === "project.ownership_transferred"),
    );
    assert.ok(
      audits.some(
        (entry) =>
          entry.action === "project.member_role_changed" &&
          entry.targetSubjectId === owner.subjectId &&
          entry.previousRole === "owner" &&
          entry.newRole === "maintainer",
      ),
    );
    assert.ok(
      audits.some(
        (entry) =>
          entry.action === "project.member_role_changed" &&
          entry.targetSubjectId === maintainer.subjectId &&
          entry.newRole === "owner",
      ),
    );
    assert.ok(project.version > initial.version);
  } finally {
    await store.close();
  }
});
