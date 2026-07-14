import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { CqutCampusVerifierProvider } from "./cqut.provider.js";

const TEST_ACCOUNT = `test-account-${randomUUID()}`;
const TEST_PASSWORD = `test-password-${randomUUID()}`;

test("CqutCampusVerifierProvider uses UIS CAS endpoints only", async () => {
  const appCode = "officeHallApplicationCode";
  const requests: Array<{ method: string; pathWithQuery: string }> = [];

  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    requests.push({
      method: req.method ?? "GET",
      pathWithQuery: `${url.pathname}${url.search}`,
    });

    if (
      url.pathname === `/center-auth-server/${appCode}/cas/login` &&
      req.method === "GET"
    ) {
      res.setHeader("Set-Cookie", "SOURCEID_TGC=test-tgc; Path=/; HttpOnly");
      res.statusCode = 200;
      res.end("ok");
      return;
    }

    if (
      url.pathname === "/center-auth-server/sso/doLogin" &&
      req.method === "POST"
    ) {
      res.setHeader("Content-Type", "application/json;charset=utf-8");
      res.end(JSON.stringify({ code: 200, msg: "登录成功" }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const provider = new CqutCampusVerifierProvider({
    schoolCode: "cqut",
    providerTimeoutMs: 3000,
    providerTotalTimeoutMs: 10000,
    uisBaseUrl: baseUrl,
    casApplicationCode: appCode,
    casServiceUrl: `${baseUrl}/ump/common/login/authSourceAuth/auth?applicationCode=${appCode}`,
  });

  try {
    const identity = await provider.verifyCredentials({
      account: TEST_ACCOUNT,
      password: TEST_PASSWORD,
    });
    assert.equal(identity.schoolUid, TEST_ACCOUNT);
    assert.equal(identity.identityHash, `cqut:${TEST_ACCOUNT}`);
    assert.equal(identity.studentStatus, "active");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  assert.equal(requests.length >= 3, true);
  assert.equal(
    requests.some((item) => item.pathWithQuery.includes("/cas/clientredirect")),
    false,
  );
  assert.equal(
    requests.some((item) =>
      item.pathWithQuery.includes(`/center-auth-server/${appCode}/cas/login`),
    ),
    true,
  );
  assert.equal(
    requests.some((item) =>
      item.pathWithQuery.startsWith("/center-auth-server/sso/doLogin"),
    ),
    true,
  );
  assert.deepEqual(
    requests.map(
      (item) => `${item.method} ${item.pathWithQuery.split("?")[0]}`,
    ),
    [
      `GET /center-auth-server/${appCode}/cas/login`,
      "POST /center-auth-server/sso/doLogin",
      `GET /center-auth-server/${appCode}/cas/login`,
    ],
  );
});

test("CqutCampusVerifierProvider normalizes account casing and whitespace in the identity key", async () => {
  const appCode = "officeHallApplicationCode";

  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (
      url.pathname === `/center-auth-server/${appCode}/cas/login` &&
      req.method === "GET"
    ) {
      res.setHeader("Set-Cookie", "SOURCEID_TGC=test-tgc; Path=/; HttpOnly");
      res.statusCode = 200;
      res.end("ok");
      return;
    }

    if (
      url.pathname === "/center-auth-server/sso/doLogin" &&
      req.method === "POST"
    ) {
      res.setHeader("Content-Type", "application/json;charset=utf-8");
      res.end(JSON.stringify({ code: 200, msg: "登录成功" }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const provider = new CqutCampusVerifierProvider({
    schoolCode: "cqut",
    providerTimeoutMs: 3000,
    providerTotalTimeoutMs: 10000,
    uisBaseUrl: baseUrl,
    casApplicationCode: appCode,
    casServiceUrl: `${baseUrl}/ump/common/login/authSourceAuth/auth?applicationCode=${appCode}`,
  });

  try {
    const upper = await provider.verifyCredentials({
      account: "  Zhang.SAN  ",
      password: TEST_PASSWORD,
    });
    const lower = await provider.verifyCredentials({
      account: "zhang.san",
      password: TEST_PASSWORD,
    });
    assert.equal(upper.schoolUid, "zhang.san");
    assert.equal(upper.identityHash, "cqut:zhang.san");
    // Casing/whitespace variants must resolve to the same identity key so one
    // human never splits into two OIDC subjects.
    assert.equal(upper.identityHash, lower.identityHash);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("CqutCampusVerifierProvider retries transient CAS login GET failures", async () => {
  const appCode = "officeHallApplicationCode";
  const requests: Array<{ method: string; pathWithQuery: string }> = [];
  let loginPageAttempts = 0;

  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    requests.push({
      method: req.method ?? "GET",
      pathWithQuery: `${url.pathname}${url.search}`,
    });

    if (
      url.pathname === `/center-auth-server/${appCode}/cas/login` &&
      req.method === "GET"
    ) {
      loginPageAttempts += 1;
      if (loginPageAttempts === 1) {
        res.statusCode = 503;
        res.end("try again");
        return;
      }
      res.setHeader("Set-Cookie", "SOURCEID_TGC=test-tgc; Path=/; HttpOnly");
      res.statusCode = 200;
      res.end("ok");
      return;
    }

    if (
      url.pathname === "/center-auth-server/sso/doLogin" &&
      req.method === "POST"
    ) {
      res.setHeader("Content-Type", "application/json;charset=utf-8");
      res.end(JSON.stringify({ code: 200, msg: "登录成功" }));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const provider = new CqutCampusVerifierProvider({
    schoolCode: "cqut",
    providerTimeoutMs: 3000,
    providerTotalTimeoutMs: 10000,
    uisBaseUrl: baseUrl,
    casApplicationCode: appCode,
    casServiceUrl: `${baseUrl}/ump/common/login/authSourceAuth/auth?applicationCode=${appCode}`,
  });

  try {
    const identity = await provider.verifyCredentials({
      account: TEST_ACCOUNT,
      password: TEST_PASSWORD,
    });
    assert.equal(identity.schoolUid, TEST_ACCOUNT);
    assert.equal(identity.studentStatus, "active");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  assert.deepEqual(
    requests.map(
      (item) => `${item.method} ${item.pathWithQuery.split("?")[0]}`,
    ),
    [
      `GET /center-auth-server/${appCode}/cas/login`,
      `GET /center-auth-server/${appCode}/cas/login`,
      "POST /center-auth-server/sso/doLogin",
      `GET /center-auth-server/${appCode}/cas/login`,
    ],
  );
});
