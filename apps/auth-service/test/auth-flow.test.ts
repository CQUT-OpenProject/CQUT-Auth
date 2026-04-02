import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { SUPPORTED_SCOPES } from "@cqut/shared";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module.js";
import { DedupeKeyService } from "../src/auth/dedupe-key.service.js";
import { PostgresService } from "../src/persistence/postgres.service.js";
import { sha256 } from "../src/common/utils.js";
import { VerificationWorkerService } from "../src/worker/verification-worker.service.js";

async function createApp(overrides: Record<string, string> = {}) {
  process.env["APP_ENV"] = "development";
  process.env["AUTH_PROVIDER"] = "mock";
  process.env["CLIENT_ID"] = "site_demo";
  process.env["CLIENT_SECRET"] = "dev-secret-change-me";
  process.env["WORKER_MODE"] = "inline";
  process.env["WORKER_INLINE_ENABLED"] = "false";
  process.env["JOB_PAYLOAD_SECRET"] = "job-secret";
  process.env["VERIFY_RATE_LIMIT_ENABLED"] = "true";
  process.env["VERIFY_RATE_LIMIT_MAX"] = "10";
  process.env["VERIFY_RATE_LIMIT_WINDOW_SECONDS"] = "60";
  process.env["STARTUP_STRICT_DEPENDENCIES"] = "false";
  delete process.env["DATABASE_URL"];
  delete process.env["REDIS_URL"];
  Object.assign(process.env, overrides);
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  return app;
}

async function registerClient(app: Awaited<ReturnType<typeof createApp>>, clientId: string, clientSecret: string) {
  const postgres = app.get(PostgresService);
  await postgres.upsertClient({
    clientId,
    clientSecretHash: sha256(clientSecret),
    allowedScopes: [...SUPPORTED_SCOPES],
    status: "active",
    createdAt: new Date().toISOString()
  });
}

function basicAuth(clientId = "site_demo", clientSecret = "dev-secret-change-me") {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

async function runWorker(app: Awaited<ReturnType<typeof createApp>>) {
  const worker = app.get(VerificationWorkerService);
  await worker.runOnce();
}

async function waitForResult(
  http: ReturnType<typeof request>,
  requestId: string,
  expectedStatus: "succeeded" | "failed"
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await http.get(`/result/${requestId}`).set("Authorization", basicAuth());
    if (response.body.status === expectedStatus) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail(`request ${requestId} did not reach ${expectedStatus}`);
}

test("dedupe_key is stable per client and unique across clients", async () => {
  const app = await createApp();
  const service = app.get(DedupeKeyService);
  const first = service.derive("site-a", "20240001");
  const second = service.derive("site-a", "20240001");
  const third = service.derive("site-b", "20240001");
  assert.equal(first, second);
  assert.notEqual(first, third);
  await app.close();
});

test("POST /verify queues a request and worker completes it", async () => {
  const app = await createApp();
  const http = request(app.getHttpServer());

  const createResponse = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "20240001",
      password: "mock-password",
      scope: ["student.verify", "student.dedupe"]
    });

  assert.equal(createResponse.status, 202);
  assert.equal(createResponse.body.status, "pending");
  assert.ok(createResponse.body.request_id);

  const pendingResponse = await http
    .get(`/result/${createResponse.body.request_id}`)
    .set("Authorization", basicAuth());
  assert.equal(pendingResponse.status, 200);
  assert.equal(pendingResponse.body.status, "pending");

  await runWorker(app);

  const resultResponse = await http
    .get(`/result/${createResponse.body.request_id}`)
    .set("Authorization", basicAuth());
  assert.equal(resultResponse.status, 200);
  assert.equal(resultResponse.body.status, "succeeded");
  assert.equal(resultResponse.body.verified, true);
  assert.equal(resultResponse.body.student_status, "active_student");
  assert.match(resultResponse.body.dedupe_key, /^ddk_/);

  await app.close();
});

test("wrong password returns failed result after worker execution", async () => {
  const app = await createApp();
  const http = request(app.getHttpServer());

  const createResponse = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "20240001",
      password: "wrong-password",
      scope: ["student.verify"]
    });

  assert.equal(createResponse.status, 202);
  await runWorker(app);

  const resultResponse = await http
    .get(`/result/${createResponse.body.request_id}`)
    .set("Authorization", basicAuth());
  assert.equal(resultResponse.body.status, "failed");
  assert.equal(resultResponse.body.error, "verification_failed");
  assert.equal(resultResponse.body.error_description, "verification failed");

  await app.close();
});

test("Basic Auth is required and old body credentials are ignored", async () => {
  const app = await createApp();
  const http = request(app.getHttpServer());

  const authFailure = await http.post("/verify").send({
    client_id: "site_demo",
    client_secret: "dev-secret-change-me",
    account: "20240001",
    password: "mock-password",
    scope: ["student.verify"]
  });
  assert.equal(authFailure.status, 401);
  assert.equal(authFailure.body.error, "invalid_client");

  const accepted = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      client_id: "bad-client",
      client_secret: "bad-secret",
      account: "20240001",
      password: "mock-password",
      scope: ["student.verify"]
    });
  assert.equal(accepted.status, 202);

  const resultFailure = await http
    .get(`/result/${accepted.body.request_id}`)
    .query({ client_id: "site_demo", client_secret: "dev-secret-change-me" });
  assert.equal(resultFailure.status, 401);
  assert.equal(resultFailure.body.error, "invalid_client");

  await app.close();
});

test("scope validation and DTO validation are enforced", async () => {
  const app = await createApp();
  const http = request(app.getHttpServer());

  const scopeFailure = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "20240001",
      password: "mock-password",
      scope: ["student.admin"]
    });
  assert.equal(scopeFailure.status, 400);
  assert.equal(scopeFailure.body.error, "invalid_scope");

  const dtoFailure = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "   ",
      password: "",
      scope: "student.verify"
    });
  assert.equal(dtoFailure.status, 400);

  await app.close();
});

test("legacy authorize route is removed", async () => {
  const app = await createApp();
  const http = request(app.getHttpServer());

  const response = await http.get("/authorize");
  assert.equal(response.status, 404);

  await app.close();
});

test("POST /verify is rate limited per client_id", async () => {
  const app = await createApp();
  const http = request(app.getHttpServer());

  for (let index = 0; index < 10; index += 1) {
    const response = await http
      .post("/verify")
      .set("Authorization", basicAuth())
      .send({
        account: `2024${String(index).padStart(4, "0")}`,
        password: "mock-password",
        scope: ["student.verify"]
      });
    assert.equal(response.status, 202);
  }

  const limited = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "20249999",
      password: "mock-password",
      scope: ["student.verify"]
    });

  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.equal(Number(limited.headers["retry-after"]) > 0, true);
  assert.equal(Number(limited.body.retry_after_seconds) > 0, true);

  await app.close();
});

test("POST /verify rate limit is isolated by client_id", async () => {
  const app = await createApp({
    VERIFY_RATE_LIMIT_MAX: "2"
  });
  const http = request(app.getHttpServer());
  await registerClient(app, "site_second", "another-secret");

  for (let index = 0; index < 2; index += 1) {
    const response = await http
      .post("/verify")
      .set("Authorization", basicAuth())
      .send({
        account: `2024200${index}`,
        password: "mock-password",
        scope: ["student.verify"]
      });
    assert.equal(response.status, 202);
  }

  const firstLimited = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "20242009",
      password: "mock-password",
      scope: ["student.verify"]
    });
  assert.equal(firstLimited.status, 429);

  const secondClient = await http
    .post("/verify")
    .set("Authorization", basicAuth("site_second", "another-secret"))
    .send({
      account: "20243000",
      password: "mock-password",
      scope: ["student.verify"]
    });
  assert.equal(secondClient.status, 202);

  await app.close();
});

test("POST /verify rate limit resets after the window expires", async () => {
  const app = await createApp({
    VERIFY_RATE_LIMIT_MAX: "1",
    VERIFY_RATE_LIMIT_WINDOW_SECONDS: "1"
  });
  const http = request(app.getHttpServer());

  const first = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "20244001",
      password: "mock-password",
      scope: ["student.verify"]
    });
  assert.equal(first.status, 202);

  const limited = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "20244002",
      password: "mock-password",
      scope: ["student.verify"]
    });
  assert.equal(limited.status, 429);

  await new Promise((resolve) => setTimeout(resolve, 1100));

  const afterReset = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "20244003",
      password: "mock-password",
      scope: ["student.verify"]
    });
  assert.equal(afterReset.status, 202);

  await app.close();
});

test("inline worker mode processes requests without Postgres or Redis", async () => {
  const app = await createApp({
    WORKER_MODE: "inline",
    WORKER_INLINE_ENABLED: "true",
    VERIFY_RATE_LIMIT_ENABLED: "false"
  });
  const http = request(app.getHttpServer());

  const createResponse = await http
    .post("/verify")
    .set("Authorization", basicAuth())
    .send({
      account: "20245001",
      password: "mock-password",
      scope: ["student.verify"]
    });

  assert.equal(createResponse.status, 202);
  const resultResponse = await waitForResult(http, createResponse.body.request_id, "succeeded");
  assert.equal(resultResponse.body.status, "succeeded");
  assert.equal(resultResponse.body.verified, true);

  await app.close();
});

test("worker loop does not refresh backlog when the queue is idle", async () => {
  const app = await createApp();
  const postgres = app.get(PostgresService);
  const worker = app.get(VerificationWorkerService);
  const originalCountQueued = postgres.countQueuedVerificationJobs.bind(postgres);
  let countCalls = 0;

  postgres.countQueuedVerificationJobs = async () => {
    countCalls += 1;
    return originalCountQueued();
  };

  const found = await worker.runOnce();
  assert.equal(found, false);
  assert.equal(countCalls, 0);

  await app.close();
});

test("health endpoints report memory readiness in inline mode", async () => {
  const app = await createApp({
    WORKER_MODE: "inline",
    WORKER_INLINE_ENABLED: "false",
    VERIFY_RATE_LIMIT_ENABLED: "false"
  });
  const http = request(app.getHttpServer());

  const live = await http.get("/health/live");
  assert.equal(live.status, 200);
  assert.equal(live.body.status, "ok");

  const ready = await http.get("/health/ready");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "ready");
  assert.equal(ready.body.database, "memory");
  assert.equal(ready.body.worker_mode, "inline");

  await app.close();
});

test("health endpoints return 503 when Redis-backed rate limiting is unavailable", async () => {
  const app = await createApp({
    WORKER_MODE: "inline",
    WORKER_INLINE_ENABLED: "false",
    REDIS_URL: "redis://127.0.0.1:6399"
  });
  const http = request(app.getHttpServer());

  const ready = await http.get("/health/ready");
  assert.equal(ready.status, 503);
  assert.equal(ready.body.status, "not_ready");
  assert.equal(ready.body.redis, "unavailable");

  await app.close();
});

test("external worker mode requires Postgres before startup", async () => {
  await assert.rejects(
    async () =>
      createApp({
        WORKER_MODE: "external"
      }),
    /DATABASE_URL is required for the current worker mode/
  );
});

test("production mode requires configured dependencies", async () => {
  await assert.rejects(
    async () =>
      createApp({
        APP_ENV: "production",
        STARTUP_STRICT_DEPENDENCIES: "true",
        WORKER_MODE: "external"
      }),
    /DATABASE_URL is required for the current worker mode/
  );
});
