import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type FetchLike = typeof fetch;

type DemoSiteOptions = {
  authServiceBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: FetchLike;
  publicDir?: string;
};

type ProxyResult = {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: string;
};

const DEFAULT_SCOPE = ["student.verify"] as const;
const DEDUPE_SCOPE = "student.dedupe";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = join(__dirname, "..", "public");
const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join("; ");

function buildBasicAuth(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

function getRuntimeConfig(options: DemoSiteOptions) {
  const appEnv = process.env["APP_ENV"] ?? process.env["NODE_ENV"] ?? "development";
  const demoClientEnabled = (() => {
    const explicit = process.env["DEMO_CLIENT_ENABLED"];
    if (explicit !== undefined) {
      return explicit.toLowerCase() === "true";
    }
    return appEnv !== "production";
  })();

  const runtime = {
    appEnv,
    demoClientEnabled,
    authServiceBaseUrl: (options.authServiceBaseUrl ?? process.env["AUTH_SERVICE_BASE_URL"] ?? "http://localhost:3001").replace(
      /\/$/,
      ""
    ),
    clientId: options.clientId ?? process.env["CLIENT_ID"] ?? "site_demo",
    clientSecret: options.clientSecret ?? process.env["CLIENT_SECRET"],
    fetchImpl: options.fetchImpl ?? fetch,
    publicDir: options.publicDir ?? DEFAULT_PUBLIC_DIR
  };

  if (runtime.appEnv === "production") {
    if (!runtime.demoClientEnabled) {
      throw new Error("DEMO_CLIENT_ENABLED must be true when demo-site runs in production");
    }
    if (!runtime.clientSecret || isPlaceholder(runtime.clientSecret)) {
      throw new Error("CLIENT_SECRET is required and must not use a placeholder value in production");
    }
  }

  if (runtime.demoClientEnabled && runtime.clientSecret && isPlaceholder(runtime.clientSecret)) {
    throw new Error("CLIENT_SECRET must not use a placeholder value");
  }

  return runtime;
}

function isPlaceholder(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.endsWith("change-me") || normalized.startsWith("<");
}

function sendProxyResponse(
  response: express.Response,
  payload: ProxyResult,
  defaultStatus = 200
) {
  if (payload.retryAfter) {
    response.setHeader("Retry-After", payload.retryAfter);
  }
  response.setHeader("Cache-Control", "no-store");
  response.status(payload.status || defaultStatus).json(payload.body);
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      error: "server_error",
      error_description: "auth service returned invalid JSON"
    };
  }
}

async function proxyJsonRequest(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit
): Promise<ProxyResult> {
  try {
    const upstream = await fetchImpl(url, init);
    const body = await parseJsonResponse(upstream);
    const retryAfter = upstream.headers.get("Retry-After");

    return {
      status: upstream.status,
      body,
      ...(retryAfter !== null ? { retryAfter } : {})
    };
  } catch {
    return {
      status: 502,
      body: {
        error: "upstream_unavailable",
        error_description: "failed to reach auth service"
      }
    };
  }
}

export function createDemoApp(options: DemoSiteOptions = {}): express.Express {
  const runtime = getRuntimeConfig(options);
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", Number(process.env["TRUST_PROXY_HOPS"] ?? (runtime.appEnv === "production" ? "1" : "0")));
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Content-Security-Policy", DEFAULT_CSP);
    if (request.path.startsWith("/demo/api/")) {
      response.setHeader("Cache-Control", "no-store");
    }
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use("/demo/assets", express.static(join(runtime.publicDir, "assets")));

  const renderDemoPage: express.RequestHandler = (_request, response) => {
    response.sendFile(join(runtime.publicDir, "index.html"));
  };

  app.get("/demo", renderDemoPage);
  app.get("/demo/", renderDemoPage);

  app.post("/demo/api/verify", async (request, response) => {
    if (!runtime.demoClientEnabled || !runtime.clientId || !runtime.clientSecret) {
      return sendProxyResponse(response, {
        status: 503,
        body: {
          error: "server_error",
          error_description: "demo client credentials are not configured"
        }
      });
    }

    const account = typeof request.body?.account === "string" ? request.body.account.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const includeDedupe = request.body?.include_dedupe === true;

    if (!account || !password) {
      return sendProxyResponse(response, {
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "account and password are required"
        }
      });
    }

    const scope = includeDedupe ? [...DEFAULT_SCOPE, DEDUPE_SCOPE] : [...DEFAULT_SCOPE];

    const proxyResult = await proxyJsonRequest(
      runtime.fetchImpl,
      `${runtime.authServiceBaseUrl}/verify`,
      {
        method: "POST",
        headers: {
          Authorization: buildBasicAuth(runtime.clientId, runtime.clientSecret),
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          account,
          password,
          scope
        })
      }
    );

    return sendProxyResponse(response, proxyResult, 202);
  });

  app.get("/demo/api/result/:requestId", async (request, response) => {
    if (!runtime.demoClientEnabled || !runtime.clientId || !runtime.clientSecret) {
      return sendProxyResponse(response, {
        status: 503,
        body: {
          error: "server_error",
          error_description: "demo client credentials are not configured"
        }
      });
    }

    const requestId = request.params.requestId;
    if (!requestId) {
      return sendProxyResponse(response, {
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "request_id is required"
        }
      });
    }

    const proxyResult = await proxyJsonRequest(
      runtime.fetchImpl,
      `${runtime.authServiceBaseUrl}/result/${encodeURIComponent(requestId)}`,
      {
        method: "GET",
        headers: {
          Authorization: buildBasicAuth(runtime.clientId, runtime.clientSecret),
          Accept: "application/json"
        }
      }
    );

    return sendProxyResponse(response, proxyResult);
  });

  return app;
}
