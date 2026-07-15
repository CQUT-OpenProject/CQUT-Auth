import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { IdentityCoreError, RetryableProviderError } from "../errors.js";
import { CqutCampusVerifierProvider } from "./cqut.provider.js";

const TEST_ACCOUNT = `test-account-${randomUUID()}`;
const TEST_PASSWORD = `test-password-${randomUUID()}`;
const APP_CODE = "officeHallApplicationCode";
const CAS_NAMESPACE = "http://www.yale.edu/tp/cas";
const TEST_TICKET = "ST-test-ticket";
const TEST_AUTH_SERVER_TOKEN = "secret-auth-server-token";

type CasServerOptions = {
  user?: string;
  uid?: string | null;
  userCode?: string | null;
  issueTicket?: boolean;
  loginPageFailures?: number;
  validationStatus?: number;
  validationXml?: string;
};

async function startCasServer(options: CasServerOptions = {}) {
  const requests: Array<{ method: string; pathWithQuery: string }> = [];
  let remainingLoginPageFailures = options.loginPageFailures ?? 0;
  const server = createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    requests.push({
      method: req.method ?? "GET",
      pathWithQuery: `${url.pathname}${url.search}`,
    });

    if (
      url.pathname === `/center-auth-server/${APP_CODE}/cas/login` &&
      req.method === "GET"
    ) {
      const loggedIn = req.headers.cookie?.includes("logged-in=yes") ?? false;
      if (!loggedIn && remainingLoginPageFailures > 0) {
        remainingLoginPageFailures -= 1;
        res.statusCode = 503;
        res.end("try again");
        return;
      }
      if (!loggedIn) {
        res.statusCode = 200;
        res.end("login page");
        return;
      }

      const service = url.searchParams.get("service");
      assert.ok(service);
      const redirect = new URL(service);
      if (options.issueTicket !== false) {
        redirect.searchParams.set("ticket", TEST_TICKET);
      }
      res.statusCode = 302;
      res.setHeader("Location", redirect.toString());
      res.end();
      return;
    }

    if (
      url.pathname === "/center-auth-server/sso/doLogin" &&
      req.method === "POST"
    ) {
      res.setHeader("Set-Cookie", "logged-in=yes; Path=/; HttpOnly");
      res.setHeader("Content-Type", "application/json;charset=utf-8");
      res.end(JSON.stringify({ code: 200, msg: "登录成功" }));
      return;
    }

    if (
      url.pathname === "/center-auth-server/cas/serviceValidate" &&
      req.method === "GET"
    ) {
      res.statusCode = options.validationStatus ?? 200;
      res.setHeader("Content-Type", "application/xml;charset=utf-8");
      res.end(options.validationXml ?? createSuccessXml(options));
      return;
    }

    if (url.pathname === "/ump/common/login/authSourceAuth/auth") {
      res.statusCode = 418;
      res.end("portal service must not be requested");
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

  return {
    baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function createProvider(baseUrl: string) {
  return new CqutCampusVerifierProvider({
    schoolCode: "cqut",
    providerTimeoutMs: 3000,
    providerTotalTimeoutMs: 10000,
    uisBaseUrl: baseUrl,
    casApplicationCode: APP_CODE,
    casServiceUrl: `${baseUrl}/ump/common/login/authSourceAuth/auth?applicationCode=${APP_CODE}`,
  });
}

function createSuccessXml(options: CasServerOptions = {}) {
  const user = options.user ?? TEST_ACCOUNT;
  const uid = options.uid === undefined ? user : options.uid;
  const userCode = options.userCode === undefined ? user : options.userCode;
  return casResponse(
    `<cas:authenticationSuccess>` +
      `<cas:user>${user}</cas:user>` +
      (uid === null ? "" : `<cas:uid>${uid}</cas:uid>`) +
      `<cas:authServerToken>${TEST_AUTH_SERVER_TOKEN}</cas:authServerToken>` +
      `<cas:attributes>` +
      (userCode === null ? "" : `<cas:user_code>${userCode}</cas:user_code>`) +
      `<cas:user_name>Ignored Name</cas:user_name>` +
      `<cas:user_user_type>3</cas:user_user_type>` +
      `</cas:attributes>` +
      `</cas:authenticationSuccess>`,
  );
}

function casResponse(body: string) {
  return `<cas:serviceResponse xmlns:cas="${CAS_NAMESPACE}">${body}</cas:serviceResponse>`;
}

test("CqutCampusVerifierProvider validates a CAS ticket without visiting the portal service", async () => {
  const upstream = await startCasServer();
  const provider = createProvider(upstream.baseUrl);
  const service = `${upstream.baseUrl}/ump/common/login/authSourceAuth/auth?applicationCode=${APP_CODE}`;

  try {
    const identity = await provider.verifyCredentials({
      account: TEST_ACCOUNT,
      password: TEST_PASSWORD,
    });
    assert.equal(identity.schoolUid, TEST_ACCOUNT);
    assert.equal(identity.identityHash, `cqut:${TEST_ACCOUNT}`);
    assert.equal(identity.studentStatus, "active");
  } finally {
    await upstream.close();
  }

  assert.deepEqual(
    upstream.requests.map(
      (item) => `${item.method} ${item.pathWithQuery.split("?")[0]}`,
    ),
    [
      `GET /center-auth-server/${APP_CODE}/cas/login`,
      "POST /center-auth-server/sso/doLogin",
      `GET /center-auth-server/${APP_CODE}/cas/login`,
      "GET /center-auth-server/cas/serviceValidate",
    ],
  );
  assert.equal(
    upstream.requests.some((item) =>
      item.pathWithQuery.startsWith("/ump/common/login/authSourceAuth/auth"),
    ),
    false,
  );
  const validationRequest = upstream.requests.find((item) =>
    item.pathWithQuery.startsWith("/center-auth-server/cas/serviceValidate?"),
  );
  assert.ok(validationRequest);
  const validationUrl = new URL(
    validationRequest.pathWithQuery,
    upstream.baseUrl,
  );
  assert.equal(validationUrl.searchParams.get("service"), service);
  assert.equal(validationUrl.searchParams.get("ticket"), TEST_TICKET);
});

test("CqutCampusVerifierProvider normalizes the CAS user before deriving the identity key", async () => {
  const upstream = await startCasServer({ user: "zhang.san" });
  const provider = createProvider(upstream.baseUrl);

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
    assert.equal(upper.identityHash, lower.identityHash);
  } finally {
    await upstream.close();
  }
});

test("CqutCampusVerifierProvider retries transient CAS login GET failures", async () => {
  const upstream = await startCasServer({ loginPageFailures: 1 });
  const provider = createProvider(upstream.baseUrl);

  try {
    const identity = await provider.verifyCredentials({
      account: TEST_ACCOUNT,
      password: TEST_PASSWORD,
    });
    assert.equal(identity.schoolUid, TEST_ACCOUNT);
    assert.equal(identity.studentStatus, "active");
  } finally {
    await upstream.close();
  }

  assert.deepEqual(
    upstream.requests.map(
      (item) => `${item.method} ${item.pathWithQuery.split("?")[0]}`,
    ),
    [
      `GET /center-auth-server/${APP_CODE}/cas/login`,
      `GET /center-auth-server/${APP_CODE}/cas/login`,
      "POST /center-auth-server/sso/doLogin",
      `GET /center-auth-server/${APP_CODE}/cas/login`,
      "GET /center-auth-server/cas/serviceValidate",
    ],
  );
});

test("CqutCampusVerifierProvider rejects untrusted CAS ticket results without leaking secrets", async (context) => {
  const cases: Array<{
    name: string;
    account?: string;
    options: CasServerOptions;
    errorType: typeof RetryableProviderError | typeof IdentityCoreError;
  }> = [
    {
      name: "missing service ticket",
      options: { issueTicket: false },
      errorType: RetryableProviderError,
    },
    {
      name: "authentication failure",
      options: {
        validationXml: casResponse(
          `<cas:authenticationFailure code="INVALID_TICKET">invalid</cas:authenticationFailure>`,
        ),
      },
      errorType: RetryableProviderError,
    },
    {
      name: "malformed XML",
      options: {
        validationXml: `<cas:serviceResponse xmlns:cas="${CAS_NAMESPACE}">`,
      },
      errorType: RetryableProviderError,
    },
    {
      name: "oversized XML",
      options: { validationXml: "x".repeat(65 * 1024) },
      errorType: RetryableProviderError,
    },
    {
      name: "doctype",
      options: {
        validationXml: `<!DOCTYPE serviceResponse>${createSuccessXml()}`,
      },
      errorType: RetryableProviderError,
    },
    {
      name: "missing user",
      options: {
        validationXml: casResponse(
          `<cas:authenticationSuccess><cas:uid>${TEST_ACCOUNT}</cas:uid></cas:authenticationSuccess>`,
        ),
      },
      errorType: RetryableProviderError,
    },
    {
      name: "duplicate user",
      options: {
        validationXml: casResponse(
          `<cas:authenticationSuccess>` +
            `<cas:user>${TEST_ACCOUNT}</cas:user>` +
            `<cas:user>${TEST_ACCOUNT}</cas:user>` +
            `</cas:authenticationSuccess>`,
        ),
      },
      errorType: RetryableProviderError,
    },
    {
      name: "conflicting UID",
      options: { uid: "different-account" },
      errorType: RetryableProviderError,
    },
    {
      name: "conflicting user_code",
      options: { userCode: "different-account" },
      errorType: RetryableProviderError,
    },
    {
      name: "CAS user differs from requested account",
      account: TEST_ACCOUNT,
      options: { user: "different-account" },
      errorType: IdentityCoreError,
    },
    {
      name: "validation service failure",
      options: { validationStatus: 503 },
      errorType: RetryableProviderError,
    },
  ];

  for (const testCase of cases) {
    await context.test(testCase.name, async () => {
      const upstream = await startCasServer(testCase.options);
      const provider = createProvider(upstream.baseUrl);
      try {
        await assert.rejects(
          provider.verifyCredentials({
            account: testCase.account ?? TEST_ACCOUNT,
            password: TEST_PASSWORD,
          }),
          (error: unknown) => {
            assert.ok(error instanceof testCase.errorType);
            assert.doesNotMatch(
              error.message,
              new RegExp(`${TEST_TICKET}|${TEST_AUTH_SERVER_TOKEN}`),
            );
            return true;
          },
        );
        assert.ok(
          upstream.requests.filter((item) =>
            item.pathWithQuery.startsWith(
              "/center-auth-server/cas/serviceValidate",
            ),
          ).length <= 1,
        );
      } finally {
        await upstream.close();
      }
    });
  }
});
