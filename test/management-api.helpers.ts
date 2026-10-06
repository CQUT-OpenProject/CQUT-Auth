import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { createOidcApp } from "../src/app.js";
import { createClientSecretDigest } from "../src/crypto.js";
import type { EmailSender } from "../src/email/email-sender.js";
import type { PolicyValues } from "../src/runtime-policy.js";
import { MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD } from "../src/identity/providers/mock.provider.js";
import { RateLimitUnavailableError } from "../src/persistence/rate-limit.service.js";

export async function clientsConfig() {
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

export async function createApp(
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

export function testPolicyOverrides(
  env: NodeJS.ProcessEnv,
): Partial<PolicyValues> {
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

export async function seedAdmin(
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

export async function login(
  agent: request.Agent,
  account: string,
): Promise<request.Response> {
  const context = await agent.get("/api/management/auth/context");
  const response = await agent
    .post("/api/management/auth/login")
    .set("X-CSRF-Token", context.body.csrfToken)
    .send({ account, password: "valid-password" });
  assert.equal(response.status, 200);
  return response;
}

export function getSetCookieValue(
  response: request.Response,
  name: string,
): string | undefined {
  const cookies = response.headers["set-cookie"] as string[] | undefined;
  if (!cookies) {
    return undefined;
  }
  const prefix = `${name}=`;
  for (const header of cookies) {
    if (!header.startsWith(prefix)) {
      continue;
    }
    const end = header.indexOf(";");
    return header.slice(prefix.length, end >= 0 ? end : undefined);
  }
  return undefined;
}

export const input = {
  clientType: "web",
  displayName: "New Web",
  description: "",
  redirectUris: ["http://localhost:3004/callback"],
  postLogoutRedirectUris: [],
  scopeWhitelist: ["openid", "profile"],
};

export {
  assert,
  mkdtempSync,
  writeFileSync,
  tmpdir,
  join,
  request,
  createOidcApp,
  createClientSecretDigest,
  EmailSender,
  PolicyValues,
  MOCK_SIMULATE_UPSTREAM_OUTAGE_PASSWORD,
  RateLimitUnavailableError,
};
