import express from "express";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAppShell, renderMessagePage } from "./render/page.js";
import { RedisDemoSessionStore, type DemoSessionStore, type DemoSession } from "./session-store.js";

type FetchLike = typeof fetch;

type DemoSiteOptions = {
  oidcIssuer?: string;
  oidcDiscoveryUrl?: string;
  oidcInternalBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  demoBaseUrl?: string;
  fetchImpl?: FetchLike;
  publicDir?: string;
  redisUrl?: string;
  sessionTtlSeconds?: number;
  sessionKeyPrefix?: string;
  sessionStore?: DemoSessionStore;
};

type DiscoveryDocument = {
  authorization_endpoint: string;
  end_session_endpoint?: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  issuer?: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = join(__dirname, "..", "public");

function getDemoSessionCookieName(cookieSecure: boolean) {
  return cookieSecure ? "__Host-demo_sid" : "demo_sid";
}

const DEFAULT_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join("; ");

function base64Url(buffer: Buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sha256Base64Url(value: string) {
  return base64Url(createHash("sha256").update(value).digest());
}

function parseCookies(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  return raw.split(";").reduce<Record<string, string>>((all, part) => {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      return all;
    }
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    all[key] = decodeURIComponent(value);
    return all;
  }, {});
}

function randomId(prefix: string) {
  return `${prefix}_${base64Url(randomBytes(18))}`;
}

function randomCodeVerifier() {
  return base64Url(randomBytes(48));
}

function buildBasicAuth(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

function getRuntimeConfig(options: DemoSiteOptions) {
  const appEnv = process.env["APP_ENV"] ?? process.env["NODE_ENV"] ?? "development";
  const isProduction = appEnv === "production";
  return {
    appEnv,
    isProduction,
    oidcIssuer: (options.oidcIssuer ?? process.env["OIDC_ISSUER"] ?? "http://localhost:3003").replace(/\/$/, ""),
    oidcDiscoveryUrl:
      options.oidcDiscoveryUrl ??
      process.env["OIDC_DISCOVERY_URL"] ??
      `${(options.oidcIssuer ?? process.env["OIDC_ISSUER"] ?? "http://localhost:3003").replace(/\/$/, "")}/.well-known/openid-configuration`,
    oidcInternalBaseUrl:
      options.oidcInternalBaseUrl ??
      process.env["OIDC_INTERNAL_BASE_URL"] ??
      (options.oidcIssuer ?? process.env["OIDC_ISSUER"] ?? "http://localhost:3003").replace(/\/$/, ""),
    clientId: options.clientId ?? process.env["OIDC_DEMO_CLIENT_ID"] ?? "demo-site",
    clientSecret: options.clientSecret ?? process.env["OIDC_DEMO_CLIENT_SECRET"] ?? "demo-site-secret",
    demoBaseUrl: (options.demoBaseUrl ?? process.env["DEMO_BASE_URL"] ?? "http://localhost:3002").replace(/\/$/, ""),
    fetchImpl: options.fetchImpl ?? fetch,
    publicDir: options.publicDir ?? DEFAULT_PUBLIC_DIR,
    redisUrl: options.redisUrl ?? process.env["REDIS_URL"],
    sessionTtlSeconds: Number(options.sessionTtlSeconds ?? process.env["DEMO_SESSION_TTL_SECONDS"] ?? 60 * 60 * 2),
    sessionKeyPrefix: options.sessionKeyPrefix ?? process.env["DEMO_SESSION_KEY_PREFIX"] ?? "demo:sess:",
    sessionStore: options.sessionStore,
    trustProxyHops: Number(process.env["TRUST_PROXY_HOPS"] ?? (isProduction ? "1" : "0")),
    cookieSecure:
      process.env["DEMO_COOKIE_SECURE"] !== undefined
        ? process.env["DEMO_COOKIE_SECURE"] !== "false"
        : isProduction
  };
}

async function parseJson(response: Response) {
  const raw = await response.text();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      error: "server_error",
      error_description: "upstream returned invalid JSON"
    };
  }
}

function rewriteEndpointToIssuer(endpoint: string, issuer: string, discoveryUrl: string) {
  const endpointUrl = new URL(endpoint);
  const issuerUrl = new URL(issuer);
  const sourceUrl = new URL(discoveryUrl);
  if (endpointUrl.origin === issuerUrl.origin) {
    return endpoint;
  }
  if (endpointUrl.origin === sourceUrl.origin || endpointUrl.hostname === sourceUrl.hostname) {
    endpointUrl.protocol = issuerUrl.protocol;
    endpointUrl.host = issuerUrl.host;
    return endpointUrl.toString();
  }
  return endpoint;
}

function rewriteEndpointToBase(endpoint: string, baseUrl: string, discoveryUrl: string) {
  const endpointUrl = new URL(endpoint);
  const base = new URL(baseUrl);
  const sourceUrl = new URL(discoveryUrl);
  if (endpointUrl.origin === base.origin) {
    return endpoint;
  }
  if (endpointUrl.origin === sourceUrl.origin || endpointUrl.hostname === sourceUrl.hostname) {
    endpointUrl.protocol = base.protocol;
    endpointUrl.host = base.host;
    return endpointUrl.toString();
  }
  return endpoint;
}

export async function createDemoApp(options: DemoSiteOptions = {}): Promise<express.Express> {
  const runtime = getRuntimeConfig(options);
  const sessionCookieName = getDemoSessionCookieName(runtime.cookieSecure);
  const discoveryCache = new Map<string, DiscoveryDocument>();
  if (!runtime.sessionStore && !runtime.redisUrl) {
    throw new Error("REDIS_URL is required for demo-site session storage");
  }
  const sessionStore =
    runtime.sessionStore ??
    new RedisDemoSessionStore({
      redisUrl: runtime.redisUrl as string,
      ttlSeconds: runtime.sessionTtlSeconds,
      keyPrefix: runtime.sessionKeyPrefix
    });
  await sessionStore.ping();
  const app = express();

  async function getDiscovery() {
    const cached = discoveryCache.get(runtime.oidcIssuer);
    if (cached) {
      return cached;
    }
    const issuerUrl = new URL(runtime.oidcIssuer);
    const discoveryUrl = new URL(runtime.oidcDiscoveryUrl);
    const response = await runtime.fetchImpl(discoveryUrl, {
      headers: {
        Accept: "application/json",
        ...(discoveryUrl.origin !== issuerUrl.origin
          ? {
              Host: issuerUrl.host,
              "X-Forwarded-Proto": issuerUrl.protocol.replace(":", ""),
              "X-Forwarded-Host": issuerUrl.host
            }
          : {})
      }
    });
    if (!response.ok) {
      throw new Error(`failed to fetch discovery document: ${response.status}`);
    }
    const body = (await response.json()) as DiscoveryDocument;
    const normalized: DiscoveryDocument = {
      ...body,
      issuer: runtime.oidcIssuer,
      authorization_endpoint: rewriteEndpointToIssuer(
        body.authorization_endpoint,
        runtime.oidcIssuer,
        runtime.oidcDiscoveryUrl
      ),
      token_endpoint: rewriteEndpointToBase(
        body.token_endpoint,
        runtime.oidcInternalBaseUrl,
        runtime.oidcDiscoveryUrl
      ),
      userinfo_endpoint: rewriteEndpointToBase(
        body.userinfo_endpoint,
        runtime.oidcInternalBaseUrl,
        runtime.oidcDiscoveryUrl
      ),
      ...(body.end_session_endpoint
        ? {
            end_session_endpoint: rewriteEndpointToIssuer(
              body.end_session_endpoint,
              runtime.oidcIssuer,
              runtime.oidcDiscoveryUrl
            )
          }
        : {})
    };
    discoveryCache.set(runtime.oidcIssuer, normalized);
    return normalized;
  }

  async function getSession(request: express.Request) {
    const cookies = parseCookies(request.headers.cookie);
    const existingId = cookies[sessionCookieName];
    if (!existingId) {
      return null;
    }
    return sessionStore.get(existingId);
  }

  async function getOrCreateSession(request: express.Request, response: express.Response) {
    const existing = await getSession(request);
    if (existing) {
      return existing;
    }
    const session: DemoSession = {
      sessionId: randomId("demo")
    };
    await sessionStore.set(session);
    response.cookie(sessionCookieName, session.sessionId, {
      httpOnly: true,
      secure: runtime.cookieSecure,
      sameSite: "lax",
      path: "/"
    });
    return session;
  }

  app.disable("x-powered-by");
  app.set("trust proxy", runtime.trustProxyHops);
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Content-Security-Policy", DEFAULT_CSP);
    next();
  });
  app.use("/demo/assets", express.static(join(runtime.publicDir, "assets")));

  app.get("/demo", async (request, response) => {
    const session = await getSession(request);
    response.setHeader("Cache-Control", "no-store");
    response.status(200).send(
      renderAppShell("CQUT OIDC Demo", session?.userInfo
        ? {
            kind: "authenticated",
            loginUrl: "/demo/login",
            logoutUrl: "/demo/logout",
            repositoryUrl: "https://github.com/CQUT-OpenProject/CQUT-Auth",
            userInfo: session.userInfo
          }
        : {
            kind: "guest",
            loginUrl: "/demo/login",
            logoutUrl: "/demo/logout",
            repositoryUrl: "https://github.com/CQUT-OpenProject/CQUT-Auth"
          })
    );
  });

  app.get("/demo/login", async (request, response) => {
    const session = await getOrCreateSession(request, response);
    const discovery = await getDiscovery();
    const state = randomId("state");
    const nonce = randomId("nonce");
    const codeVerifier = randomCodeVerifier();
    const challenge = sha256Base64Url(codeVerifier);
    session.pendingAuth = { state, nonce, codeVerifier };
    await sessionStore.set(session);

    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set("client_id", runtime.clientId);
    authorizationUrl.searchParams.set("redirect_uri", `${runtime.demoBaseUrl}/demo/callback`);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "openid profile email student offline_access");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");

    response.redirect(302, authorizationUrl.toString());
  });

  app.get("/demo/callback", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const session = await getSession(request);
    if (!session) {
      response.status(400).send(renderMessagePage("Invalid Callback", "Missing session."));
      return;
    }
    const pending = session.pendingAuth;
    const code = typeof request.query["code"] === "string" ? request.query["code"] : undefined;
    const state = typeof request.query["state"] === "string" ? request.query["state"] : undefined;
    if (!pending || !code || !state || pending.state !== state) {
      response.status(400).send(renderMessagePage("Callback Error", "State mismatch or missing code."));
      return;
    }

    try {
      const discovery = await getDiscovery();
      const tokenResponse = await runtime.fetchImpl(discovery.token_endpoint, {
        method: "POST",
        headers: {
          Authorization: buildBasicAuth(runtime.clientId, runtime.clientSecret),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${runtime.demoBaseUrl}/demo/callback`,
          code_verifier: pending.codeVerifier
        })
      });
      const tokenBody = await parseJson(tokenResponse);
      if (!tokenResponse.ok) {
        response.status(502).send(
          renderMessagePage(
            "Token Exchange Failed",
            "Token endpoint rejected the request.",
            JSON.stringify(tokenBody, null, 2)
          )
        );
        return;
      }

      const accessToken =
        typeof tokenBody["access_token"] === "string" ? tokenBody["access_token"] : undefined;
      const idToken = typeof tokenBody["id_token"] === "string" ? tokenBody["id_token"] : undefined;
      if (!accessToken) {
        response.status(502).send(
          renderMessagePage("Token Exchange Failed", "Token response missing access_token.")
        );
        return;
      }

      const userInfoResponse = await runtime.fetchImpl(discovery.userinfo_endpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      });
      const userInfoBody = await parseJson(userInfoResponse);
      if (!userInfoResponse.ok) {
        response.status(502).send(
          renderMessagePage(
            "UserInfo Failed",
            "UserInfo request failed.",
            JSON.stringify(userInfoBody, null, 2)
          )
        );
        return;
      }

      session.pendingAuth = undefined;
      session.idToken = idToken ?? undefined;
      session.userInfo = userInfoBody;
      await sessionStore.set(session);
      response.redirect(302, "/demo");
    } catch (error) {
      response.status(502).send(
        renderMessagePage(
          "Callback Error",
          error instanceof Error ? error.message : "Unknown callback error"
        )
      );
    }
  });

  app.get("/demo/logout", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const cookies = parseCookies(request.headers.cookie);
    const sessionId = cookies[sessionCookieName];
    const session = sessionId ? await sessionStore.get(sessionId) : null;
    const idToken = session?.idToken;
    if (sessionId) {
      await sessionStore.destroy(sessionId);
      response.clearCookie(sessionCookieName, {
        httpOnly: true,
        secure: runtime.cookieSecure,
        sameSite: "lax",
        path: "/"
      });
    }
    if (!idToken) {
      response.redirect(302, "/demo/logout-complete");
      return;
    }
    try {
      const discovery = await getDiscovery();
      if (!discovery.end_session_endpoint) {
        response.redirect(302, "/demo/logout-complete");
        return;
      }
      const logoutUrl = new URL(discovery.end_session_endpoint);
      logoutUrl.searchParams.set("id_token_hint", idToken);
      logoutUrl.searchParams.set("post_logout_redirect_uri", `${runtime.demoBaseUrl}/demo/logout-complete`);
      response.redirect(302, logoutUrl.toString());
    } catch {
      response.redirect(302, "/demo/logout-complete");
    }
  });

  app.get("/demo/logout-complete", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).send(
      renderMessagePage("Signed Out", "You have signed out successfully.")
    );
  });

  return app;
}
