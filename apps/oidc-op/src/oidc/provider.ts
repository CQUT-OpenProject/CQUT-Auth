import {
  type CampusVerifierProvider,
  CqutCampusVerifierProvider,
  IdentityLinkService,
  InteractiveAuthenticatorService,
  MockCampusVerifierProvider,
  ProviderRegistry,
  SubjectProfileService
} from "@cqut/identity-core";
import { OIDC_CLAIMS, OIDC_SCOPES } from "@cqut/shared";
import { exportJWK, generateKeyPair } from "jose";
import Provider from "oidc-provider";
import KeyStore from "oidc-provider/lib/helpers/keystore.js";
import oidcProviderInstance from "oidc-provider/lib/helpers/weak_cache.js";
import type { OidcOpConfig } from "../config.js";
import type { OidcPersistence, OidcSigningKeyRecord } from "../persistence/contracts.js";
import { RateLimitService, RateLimitUnavailableError } from "../persistence/rate-limit.service.js";
import { resolveTrustedKoaRequestIp } from "../request-ip.js";
import { createAdapter } from "./adapter.js";
import { verifyClientSecretDigest } from "../crypto.js";
import { randomId, parseScope, escapeHtml } from "../utils.js";
import { upsertOidcClientsFromConfig } from "./client-config.js";
import type { EmailSender, SendVerificationCodeInput } from "../email/email-sender.js";
import { ResendEmailSender } from "../email/resend-email-sender.js";

export type OidcServices = {
  provider: any;
  interactiveAuthenticator: InteractiveAuthenticatorService;
  subjectProfileService: SubjectProfileService;
  emailSender: EmailSender;
  close(): Promise<void>;
};

type SigningJwk = JsonWebKey & {
  kid: string;
  alg: string;
  use: string;
};

type SessionTtlState = {
  loginTs?: unknown;
  iat?: unknown;
};

type TokenRateLimitIdentitySource = "client_secret_basic" | "none" | "anonymous";

type TokenRateLimitIdentity = {
  source: TokenRateLimitIdentitySource;
  clientId: string;
  ip: string;
  subjectId?: string;
};

class TokenRateLimitError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly code: "service_unavailable" | "rate_limited";
  readonly errorDescription: string;
  readonly retryAfterSeconds: number;
  readonly expose: boolean;

  constructor(
    status: number,
    code: "service_unavailable" | "rate_limited",
    errorDescription: string,
    retryAfterSeconds: number
  ) {
    super(code);
    this.name = "TokenRateLimitError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.errorDescription = errorDescription;
    this.retryAfterSeconds = retryAfterSeconds;
    this.expose = true;
  }
}

class DisabledEmailSender implements EmailSender {
  async sendVerificationCode(_input: SendVerificationCodeInput): Promise<void> {
    throw new Error("email verification sender is not configured");
  }
}

const wrappedTokenHandlers = new WeakSet<(ctx: any) => Promise<unknown>>();

function parseEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeClientId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (Array.isArray(value) && value.length > 0) {
    return normalizeClientId(value[0]);
  }
  return undefined;
}

function resolveBasicClientId(ctx: any): string | undefined {
  const authorization = typeof ctx.get === "function" ? ctx.get("authorization") : undefined;
  if (typeof authorization === "string" && authorization.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        const clientId = normalizeClientId(decoded.slice(0, separator));
        if (clientId) {
          return clientId;
        }
      }
    } catch {
      // Ignore malformed Authorization header and let downstream auth handling decide.
    }
  }
  return undefined;
}

function resolveRequestIp(config: Pick<OidcOpConfig, "trustProxyHops">, ctx: any) {
  return resolveTrustedKoaRequestIp(config, ctx);
}

function createTokenRateLimitKeys(identity: TokenRateLimitIdentity) {
  const scope = `oidc:token:${identity.source}`;
  const keys = [
    `${scope}:client:${identity.clientId}`,
    `${scope}:ip:${identity.ip}`,
    `${scope}:client-ip:${identity.clientId}:${identity.ip}`
  ];
  if (identity.subjectId) {
    keys.push(`${scope}:subject:${identity.subjectId}`);
  }
  return keys;
}

function shouldRateLimitAnonymousTokenResponse(ctx: any) {
  if (ctx.status !== 400 && ctx.status !== 401) {
    return false;
  }
  const responseError = typeof ctx.body?.error === "string" ? ctx.body.error : undefined;
  return responseError === "invalid_request" || responseError === "invalid_client";
}

function resolveClientRateLimitSource(clientAuthMethod: unknown): Extract<TokenRateLimitIdentitySource, "client_secret_basic" | "none"> {
  return clientAuthMethod === "none" ? "none" : "client_secret_basic";
}

async function evaluateTokenRateLimit(
  config: OidcOpConfig,
  rateLimitService: RateLimitService,
  ctx: any,
  identity: TokenRateLimitIdentity
) {
  const appliedKeys: Set<string> = ctx.state.tokenRateLimitAppliedKeys ??= new Set<string>();
  try {
    for (const key of createTokenRateLimitKeys(identity)) {
      if (appliedKeys.has(key)) {
        continue;
      }
      const decision = await rateLimitService.consume(
        key,
        config.tokenRateLimitMax,
        config.tokenRateLimitWindowSeconds
      );
      appliedKeys.add(key);
      if (!decision.allowed) {
        return new TokenRateLimitError(429, "rate_limited", "token endpoint rate limit exceeded", decision.retryAfterSeconds);
      }
    }
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      return new TokenRateLimitError(503, "service_unavailable", "rate limiting backend is unavailable", 60);
    }
    throw error;
  }
  return undefined;
}

function resolveSubjectRateLimitIdentity(ctx: any): string | undefined {
  const accountId = ctx.oidc?.session?.accountId;
  return typeof accountId === "string" && accountId.trim().length > 0 ? accountId : undefined;
}

function isTokenRequestPath(pathname: string, tokenPath: string) {
  return pathname === tokenPath || pathname.endsWith(tokenPath);
}

function replyWithTokenError(
  ctx: any,
  tokenRateLimitError: TokenRateLimitError
) {
  ctx.status = tokenRateLimitError.status;
  ctx.set("Retry-After", String(tokenRateLimitError.retryAfterSeconds));
  ctx.set("Cache-Control", "no-store");
  ctx.body = {
    error: tokenRateLimitError.code,
    error_description: tokenRateLimitError.errorDescription
  };
}

function createTokenRateLimitMiddleware(
  config: OidcOpConfig,
  rateLimitService: RateLimitService,
  tokenPath: string
) {
  return async (ctx: any, next: () => Promise<unknown>) => {
    if (ctx.method !== "POST" || !isTokenRequestPath(ctx.path, tokenPath)) {
      await next();
      return;
    }

    const ip = resolveRequestIp(config, ctx);
    const basicClientId = resolveBasicClientId(ctx);
    if (basicClientId) {
      const basicRateLimitError = await evaluateTokenRateLimit(config, rateLimitService, ctx, {
        source: "client_secret_basic",
        clientId: basicClientId,
        ip
      });
      if (basicRateLimitError) {
        replyWithTokenError(ctx, basicRateLimitError);
        return;
      }
      ctx.state.tokenRateLimitClientIdentitySeen = true;
    }

    await next();

    const resolvedClientId = normalizeClientId(ctx.oidc?.client?.clientId);
    if (ctx.state.tokenRateLimitClientIdentitySeen || resolvedClientId || !shouldRateLimitAnonymousTokenResponse(ctx)) {
      return;
    }
    const anonymousRateLimitError = await evaluateTokenRateLimit(config, rateLimitService, ctx, {
      source: "anonymous",
      clientId: "unauthenticated",
      ip
    });
    if (anonymousRateLimitError) {
      replyWithTokenError(ctx, anonymousRateLimitError);
    }
  };
}

function wrapTokenGrantHandlersWithRateLimit(provider: any, config: OidcOpConfig, rateLimitService: RateLimitService) {
  const internals = oidcProviderInstance(provider);
  const grantTypeHandlers: Map<string, (ctx: any) => Promise<unknown>> = internals.grantTypeHandlers;
  for (const [grantType, handler] of grantTypeHandlers.entries()) {
    if (wrappedTokenHandlers.has(handler)) {
      continue;
    }
    const wrappedHandler = async (ctx: any) => {
      const clientId = normalizeClientId(ctx.oidc?.client?.clientId);
      if (clientId) {
        const subjectId = resolveSubjectRateLimitIdentity(ctx);
        const clientRateLimitError = await evaluateTokenRateLimit(config, rateLimitService, ctx, {
          source: resolveClientRateLimitSource(ctx.oidc.client.clientAuthMethod),
          clientId,
          ip: resolveRequestIp(config, ctx),
          ...(subjectId ? { subjectId } : {})
        });
        if (clientRateLimitError) {
          replyWithTokenError(ctx, clientRateLimitError);
          return;
        }
      }
      return handler(ctx);
    };
    wrappedTokenHandlers.add(wrappedHandler);
    grantTypeHandlers.set(grantType, wrappedHandler);
  }
}

function installTokenRateLimitMiddleware(provider: any, config: OidcOpConfig, rateLimitService: RateLimitService) {
  const tokenPath = provider.pathFor("token");
  provider.use(createTokenRateLimitMiddleware(config, rateLimitService, tokenPath));
  wrapTokenGrantHandlersWithRateLimit(provider, config, rateLimitService);
}

export function computeSessionTtlSeconds(
  session: SessionTtlState | undefined,
  config: Pick<OidcOpConfig, "sessionIdleTtlSeconds" | "sessionTtlSeconds">,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  const loginTs = parseEpochSeconds(session?.loginTs);
  const issuedAt = parseEpochSeconds(session?.iat);
  const absoluteAnchor = loginTs ?? issuedAt ?? nowSeconds;
  const elapsed = Math.max(0, nowSeconds - absoluteAnchor);
  const absoluteRemaining = Math.max(0, config.sessionTtlSeconds - elapsed);

  return Math.min(config.sessionIdleTtlSeconds, absoluteRemaining);
}

function asPublicSigningJwk(jwk: SigningJwk): SigningJwk {
  const {
    d,
    p,
    q,
    dp,
    dq,
    qi,
    oth,
    priv,
    k,
    key_ops,
    ...publicJwk
  } = jwk as SigningJwk & {
    d?: string;
    p?: string;
    q?: string;
    dp?: string;
    dq?: string;
    qi?: string;
    oth?: unknown;
    priv?: string;
    k?: string;
    key_ops?: string[];
  };
  void d;
  void p;
  void q;
  void dp;
  void dq;
  void qi;
  void oth;
  void priv;
  void k;
  void key_ops;
  return publicJwk;
}

function signingJwksFingerprint(jwks: SigningJwk[]) {
  return jwks
    .map((item) => JSON.stringify(item))
    .sort()
    .join("|");
}

function replaceProviderSigningKeyset(provider: any, signingJwks: SigningJwk[]) {
  const internals = oidcProviderInstance(provider);
  const keyStore = new KeyStore();
  for (const jwk of signingJwks) {
    keyStore.add(structuredClone(jwk));
  }
  internals.keystore = keyStore;
  internals.jwks = {
    keys: signingJwks.map((jwk) => asPublicSigningJwk(structuredClone(jwk)))
  };
}

function installClientSecretDigestValidation(provider: any) {
  const originalFind = provider.Client.find.bind(provider.Client);
  provider.Client.find = async (id: string) => {
    const providerClient = await originalFind(id);
    if (providerClient && typeof providerClient.clientSecretDigest === "string") {
      const digest = providerClient.clientSecretDigest;
      providerClient.compareClientSecret = async (actual: string) =>
        verifyClientSecretDigest(actual, digest);
    }
    return providerClient;
  };
}

function startSigningKeyRefreshLoop(
  provider: any,
  store: OidcPersistence,
  refreshIntervalSeconds: number,
  initialSigningJwks: SigningJwk[]
) {
  let currentFingerprint = signingJwksFingerprint(initialSigningJwks);
  const refresh = async () => {
    try {
      const loaded = await store.loadPrivateSigningJwks(["active", "retiring"]);
      const nextSigningJwks = loaded as SigningJwk[];
      if (nextSigningJwks.length === 0) {
        console.error("[oidc-op] signing key refresh skipped: no active or retiring keys available");
        return;
      }
      const nextFingerprint = signingJwksFingerprint(nextSigningJwks);
      if (nextFingerprint === currentFingerprint) {
        return;
      }
      replaceProviderSigningKeyset(provider, nextSigningJwks);
      currentFingerprint = nextFingerprint;
      console.warn("[oidc-op] signing keyset reloaded without restart");
    } catch (error) {
      console.error("[oidc-op] signing key refresh failed; keeping previous keyset", error);
    }
  };
  const timer = setInterval(() => {
    void refresh();
  }, refreshIntervalSeconds * 1000);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
  };
}

function normalizeIssuer(issuer: string): string {
  return issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
}

function renderAutoLogoutPage(form: string) {
  const formWithExplicitLogout =
    form.includes('name="logout"')
      ? form
      : form.replace("</form>", '<input type="hidden" name="logout" value="yes"/></form>');
  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>正在退出登录</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body>
      ${formWithExplicitLogout}
      <p>正在为你退出登录...</p>
      <p>如果页面没有自动继续，请点击下方按钮完成退出。</p>
      <button form="op.logoutForm" type="submit" name="logout" value="yes">继续退出</button>
      <script src="/session/logout-auto-submit.js" defer></script>
    </body>
  </html>`;
}

function renderLogoutSuccessPage() {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <title>已退出登录</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body>
      <h1>你已退出登录。</h1>
      <p>当前认证会话已安全结束。</p>
    </body>
  </html>`;
}

async function ensureSigningKey(store: OidcPersistence, config: OidcOpConfig) {
  const existing = await store.listSigningKeys(["active", "retiring"]);
  if (existing.length > 0) {
    return existing;
  }
  if (!config.autoSeedSigningKey) {
    throw new Error("no signing keys available; run pnpm --filter @cqut/oidc-op seed:key");
  }
  const created = await generateSigningKey(store);
  return [created];
}

export async function generateSigningKey(store: OidcPersistence): Promise<OidcSigningKeyRecord> {
  const kid = randomId("kid");
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const now = new Date().toISOString();
  const record: OidcSigningKeyRecord = {
    kid,
    alg: "RS256",
    use: "sig",
    publicJwk: {
      ...publicJwk,
      kid,
      alg: "RS256",
      use: "sig"
    } as SigningJwk,
    privateJwkCiphertext: await store.encryptPrivateJwk({
      ...privateJwk,
      kid,
      alg: "RS256",
      use: "sig"
    } as SigningJwk),
    status: "active",
    createdAt: now,
    activatedAt: now
  };
  await store.upsertSigningKey(record);
  return record;
}

export async function createOidcServices(
  config: OidcOpConfig,
  store: OidcPersistence,
  rateLimitService: RateLimitService,
  providedEmailSender?: EmailSender
): Promise<OidcServices> {
  await upsertOidcClientsFromConfig(store, config);
  await ensureSigningKey(store, config);

  const providerRegistry = new ProviderRegistry(
    new Map<string, CampusVerifierProvider>([
      [
        "mock",
        new MockCampusVerifierProvider({
          schoolCode: config.schoolCode
        })
      ],
      [
        "cqut",
        new CqutCampusVerifierProvider({
          schoolCode: config.schoolCode,
          providerTimeoutMs: config.providerTimeoutMs,
          providerTotalTimeoutMs: config.providerTotalTimeoutMs,
          uisBaseUrl: config.cqutUisBaseUrl,
          casApplicationCode: config.cqutCasApplicationCode,
          casServiceUrl: config.cqutCasServiceUrl
        })
      ]
    ]),
    config.authProvider
  );
  const identityLinkService = new IdentityLinkService(store);
  const subjectProfileService = new SubjectProfileService(store);
  const emailSender =
    providedEmailSender ??
    (config.resendApiKey && config.emailFrom
      ? new ResendEmailSender({
          apiKey: config.resendApiKey,
          from: config.emailFrom
        })
      : new DisabledEmailSender());
  const interactiveAuthenticator = new InteractiveAuthenticatorService(
    providerRegistry,
    identityLinkService,
    subjectProfileService,
    store
  );

  const initialSigningJwks = await store.loadPrivateSigningJwks(["active", "retiring"]);
  if (initialSigningJwks.length === 0) {
    throw new Error("no signing keys available after initialization");
  }
  const jwks = { keys: initialSigningJwks };
  const sessionCookieName = config.cookieSecure ? "__Host-op_sid" : "op_sid";
  const provider = new Provider(normalizeIssuer(config.issuer), {
    adapter: createAdapter(store),
    jwks,
    clientAuthMethods: ["client_secret_basic", "none"],
    responseTypes: ["code"],
    pkce: {
      required() {
        return true;
      }
    },
    claims: {
      openid: ["sub"],
      profile: ["preferred_username", "name"],
      email: ["email", "email_verified"],
      student: ["status"]
    },
    clientDefaults: {
      token_endpoint_auth_method: "client_secret_basic"
    },
    cookies: {
      keys: config.cookieKeys,
      names: {
        session: sessionCookieName,
        interaction: "_interaction",
        resume: "_interaction_resume"
      },
      long: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: config.cookieSecure
      },
      short: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: config.cookieSecure
      }
    },
    discovery: {
      claims_supported: [...OIDC_CLAIMS]
    },
    features: {
      devInteractions: { enabled: false },
      claimsParameter: { enabled: false },
      clientCredentials: { enabled: false },
      deviceFlow: { enabled: false },
      introspection: { enabled: false },
      registration: { enabled: false },
      revocation: { enabled: false },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource(ctx: any, form: string) {
          ctx.type = "html";
          ctx.set("Cache-Control", "no-store");
          ctx.body = renderAutoLogoutPage(form);
        },
        postLogoutSuccessSource(ctx: any) {
          const redirectUri =
            typeof ctx.oidc?.params?.post_logout_redirect_uri === "string"
              ? ctx.oidc.params.post_logout_redirect_uri
              : undefined;
          const state =
            typeof ctx.oidc?.params?.state === "string"
              ? ctx.oidc.params.state
              : undefined;

          ctx.set("Cache-Control", "no-store");
          if (redirectUri) {
            const target = new URL(redirectUri);
            if (state) {
              target.searchParams.set("state", state);
            }
            ctx.redirect(target.toString());
            return;
          }

          ctx.type = "html";
          ctx.body = renderLogoutSuccessPage();
        }
      }
    },
    extraClientMetadata: {
      properties: ["clientSecretDigest"],
      validator() {}
    },
    findAccount: async (_ctx: any, sub: string) => {
      const principal = await store.findPrincipalBySubjectId(sub);
      if (!principal) {
        return undefined;
      }
      return {
        accountId: sub,
        async claims(_use: any, scope: string) {
          const grantedScopes = new Set(parseScope(scope));
          const claims: Record<string, unknown> = {
            sub
          };
          if (grantedScopes.has("profile")) {
            claims["preferred_username"] = principal.preferredUsername;
            claims["name"] = principal.displayName ?? `CQUT User ${principal.schoolUid}`;
          }
          if (grantedScopes.has("email") && principal.email && principal.emailVerified) {
            claims["email"] = principal.email;
            claims["email_verified"] = true;
          }
          if (grantedScopes.has("student")) {
            claims["status"] = principal.studentStatus;
          }
          return claims;
        }
      };
    },
    interactions: {
      url(_ctx: any, interaction: { uid: string }) {
        return `/interaction/${interaction.uid}`;
      }
    },
    issueRefreshToken(_ctx: any, client: any, code: any) {
      if (!client.grantTypeAllowed("refresh_token")) {
        return false;
      }
      return code.scopes.has("offline_access");
    },
    loadExistingGrant: async (ctx: any) => {
      const sessionGrantId = ctx.oidc.session?.grantIdFor(ctx.oidc.client.clientId);
      if (sessionGrantId) {
        return ctx.oidc.provider.Grant.find(sessionGrantId);
      }
      const grant = new ctx.oidc.provider.Grant({
        accountId: ctx.oidc.session.accountId,
        clientId: ctx.oidc.client.clientId
      });
      await grant.save();
      return grant;
    },
    renderError(ctx: any, out: Record<string, unknown>) {
      console.error("[oidc-op] provider renderError", out);
      ctx.type = "html";
      ctx.set("Cache-Control", "no-store");
      ctx.body = `<!DOCTYPE html>
        <html lang="zh-CN">
        <head><meta charset="utf-8"><title>认证请求失败</title></head>
        <body>
          <h1>认证请求失败</h1>
          <p>${escapeHtml("认证请求未能完成，请刷新后重试。")}</p>
        </body>
        </html>`;
    },
    rotateRefreshToken() {
      return true;
    },
    routes: {
      authorization: "/auth",
      token: "/token",
      userinfo: "/userinfo",
      jwks: "/jwks",
      end_session: "/session/end"
    },
    scopes: [...OIDC_SCOPES],
    subjectTypes: ["public"],
    ttl: {
      AccessToken: () => config.accessTokenTtlSeconds,
      AuthorizationCode: () => config.authorizationCodeTtlSeconds,
      Grant: () => config.refreshTokenTtlSeconds,
      IdToken: () => config.idTokenTtlSeconds,
      Interaction: () => config.interactionTtlSeconds,
      RefreshToken: () => config.refreshTokenTtlSeconds,
      Session: (_ctx: any, session: SessionTtlState) =>
        computeSessionTtlSeconds(session, {
          sessionIdleTtlSeconds: config.sessionIdleTtlSeconds,
          sessionTtlSeconds: config.sessionTtlSeconds
        })
    }
  });
  provider.proxy = true;
  installClientSecretDigestValidation(provider);
  const stopSigningKeyRefresh = startSigningKeyRefreshLoop(
    provider,
    store,
    config.signingKeyRefreshIntervalSeconds,
    initialSigningJwks as SigningJwk[]
  );

  installTokenRateLimitMiddleware(provider, config, rateLimitService);

  return {
    provider,
    interactiveAuthenticator,
    subjectProfileService,
    emailSender,
    async close() {
      await stopSigningKeyRefresh();
    }
  };
}
