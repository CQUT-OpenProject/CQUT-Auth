import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { Request } from "express";
import {
  issueManagementCsrf,
  validateManagementCsrf,
} from "../src/management/management-security.js";

function requestWithOrigin(origin: string): Request {
  const headers = new Map([
    ["origin", origin],
    [
      "x-csrf-token",
      issueManagementCsrf(
        {
          csrfSigningSecret: "synthetic-csrf-secret",
          csrfTokenTtlSeconds: 600,
        },
        "synthetic-session",
        1000,
      ),
    ],
  ]);
  return {
    get: (name: string) => headers.get(name.toLowerCase()) ?? undefined,
  } as unknown as Request;
}

test("management CSRF accepts local UI origins only outside production", () => {
  const issuer = "https://verify.local";
  const developmentConfig = {
    appEnv: "development",
    csrfSigningSecret: "synthetic-csrf-secret",
    issuer,
  };

  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
    assert.equal(
      validateManagementCsrf(
        requestWithOrigin(origin),
        developmentConfig,
        "synthetic-session",
        1100,
      ),
      true,
    );
    assert.equal(
      validateManagementCsrf(
        requestWithOrigin(origin),
        { ...developmentConfig, appEnv: "production" },
        "synthetic-session",
        1100,
      ),
      false,
    );
  }

  assert.equal(
    validateManagementCsrf(
      requestWithOrigin("https://attacker.example"),
      developmentConfig,
      "synthetic-session",
      1100,
    ),
    false,
  );
});
