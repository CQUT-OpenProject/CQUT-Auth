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
      pathWithQuery: `${url.pathname}${url.search}`
    });

    if (url.pathname === `/center-auth-server/${appCode}/cas/login` && req.method === "GET") {
      res.setHeader("Set-Cookie", "SOURCEID_TGC=test-tgc; Path=/; HttpOnly");
      res.statusCode = 200;
      res.end("ok");
      return;
    }

    if (url.pathname === "/center-auth-server/sso/doLogin" && req.method === "POST") {
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
    casServiceUrl: `${baseUrl}/ump/common/login/authSourceAuth/auth?applicationCode=${appCode}`
  });

  try {
    const identity = await provider.verifyCredentials({
      account: TEST_ACCOUNT,
      password: TEST_PASSWORD
    });
    assert.equal(identity.schoolUid, TEST_ACCOUNT);
    assert.equal(identity.identityHash, `cqut:${TEST_ACCOUNT}`);
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
    false
  );
  assert.equal(
    requests.some((item) => item.pathWithQuery.includes(`/center-auth-server/${appCode}/cas/login`)),
    true
  );
  assert.equal(
    requests.some((item) => item.pathWithQuery.startsWith("/center-auth-server/sso/doLogin")),
    true
  );
});
