import { ProviderRegistry } from "../identity/provider-registry.js";
import { CqutCampusVerifierProvider } from "../identity/providers/cqut.provider.js";
import { MockCampusVerifierProvider } from "../identity/providers/mock.provider.js";
import { IdentityLinkService } from "../identity/services/identity-link.service.js";
import { InteractiveAuthenticatorService } from "../identity/services/interactive-authenticator.service.js";
import { SubjectProfileService } from "../identity/services/subject-profile.service.js";
import type { CampusVerifierProvider } from "../identity/types.js";
import { OIDC_CLAIMS, OIDC_SCOPES } from "../shared/oidc-contracts.js";
import { exportJWK, generateKeyPair } from "jose";
import Provider from "oidc-provider";
import type { StaticConfig } from "../config.js";
import type {
  OidcSigningKeyRecord,
  SigningKeyRepository,
} from "../persistence/contracts.js";
import type { PersistenceModules } from "../persistence/persistence.js";
import {
  RateLimitService,
  RateLimitUnavailableError,
} from "../persistence/rate-limit.service.js";
import { resolveTrustedKoaRequestIp } from "../request-ip.js";
import { createAdapter } from "./adapter.js";
import { renderBrandedPage } from "../pages/branded-page.js";
import { verifyClientSecretDigest } from "../crypto.js";
import { randomId, parseScope, escapeHtml } from "../utils.js";
import { initializeOidcClientsFromConfig } from "./client-config.js";
import type { EmailSender } from "../email/email-sender.js";
import { RuntimeEmailSender } from "../email/runtime-email-sender.js";
import type { RuntimePolicyModule } from "../runtime-policy.js";
import type { Request, Response, RequestHandler } from "express";
import {
  decorateClientFinder,
  replaceSigningKeyset,
  wrapGrantHandlers,
  type RawOidcProvider,
} from "./provider-internals.adapter.js";

export type OidcInteractionDetails = {
  uid: string;
  prompt: {
    name: string;
    details: {
      missingOIDCScope?: string[];
      missingOIDCClaims?: string[];
      missingResourceScopes?: Record<string, string[]>;
    };
  };
  params: { client_id?: unknown; scope?: unknown };
  session: { accountId?: string };
  grantId?: string;
};

export type OidcInteractionPort = {
  details(
    request: Request,
    response: Response,
  ): Promise<OidcInteractionDetails>;
  finishLogin(
    request: Request,
    response: Response,
    login: { accountId: string; authTime: number },
  ): Promise<void>;
  finishConsent(
    request: Request,
    response: Response,
    details?: OidcInteractionDetails,
  ): Promise<boolean>;
  denyConsent(request: Request, response: Response): Promise<void>;
};

export type OidcRuntime = {
  middleware: RequestHandler;
  interactions: OidcInteractionPort;
  interactiveAuthenticator: InteractiveAuthenticatorService;
  subjectProfileService: SubjectProfileService;
  emailSender: EmailSender;
  runtimePolicy: RuntimePolicyModule;
  close(): Promise<void>;
};

function createInteractionPort(provider: RawOidcProvider): OidcInteractionPort {
  return {
    details: (request, response) =>
      provider.interactionDetails(request, response),
    async finishLogin(request, response, login) {
      await provider.interactionFinished(
        request,
        response,
        {
          login: {
            accountId: login.accountId,
            acr: "urn:cqut:loa:1",
            amr: ["pwd"],
            remember: false,
            ts: login.authTime,
          },
        },
        { mergeWithLastSubmission: false },
      );
    },
    async finishConsent(request, response, providedDetails) {
      const details: OidcInteractionDetails =
        providedDetails ??
        (await provider.interactionDetails(request, response));
      const { prompt, params, session, grantId } = details;
      if (prompt.name !== "consent") return false;
      const grant = grantId
        ? await provider.Grant.find(grantId)
        : new provider.Grant({
            accountId: session.accountId,
            clientId: String(params.client_id),
          });
      if (prompt.details.missingOIDCScope)
        grant.addOIDCScope(prompt.details.missingOIDCScope.join(" "));
      if (prompt.details.missingOIDCClaims)
        grant.addOIDCClaims(prompt.details.missingOIDCClaims);
      if (prompt.details.missingResourceScopes) {
        for (const [indicator, scope] of Object.entries(
          prompt.details.missingResourceScopes,
        )) {
          grant.addResourceScope(indicator, (scope as string[]).join(" "));
        }
      }
      await provider.interactionFinished(
        request,
        response,
        { consent: { grantId: await grant.save() } },
        { mergeWithLastSubmission: true },
      );
      return true;
    },
    async denyConsent(request, response) {
      await provider.interactionFinished(
        request,
        response,
        {
          error: "access_denied",
          error_description: "resource owner denied consent",
        },
        { mergeWithLastSubmission: false },
      );
    },
  };
}

type SigningJwk = JsonWebKey & {
  kid: string;
  alg: string;
  use: string;
};

type SessionTtlState = {
  loginTs?: unknown;
  iat?: unknown;
};

type TokenRateLimitIdentitySource =
  | "client_secret_basic"
  | "none"
  | "anonymous";

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
    retryAfterSeconds: number,
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

function normalizeStatusClaim(status: string) {
  return status === "active_student" ? "active" : status;
}

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
  const authorization =
    typeof ctx.get === "function" ? ctx.get("authorization") : undefined;
  if (typeof authorization === "string" && authorization.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(
        authorization.slice("Basic ".length),
        "base64",
      ).toString("utf8");
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

function resolveRequestIp(
  config: Pick<StaticConfig, "trustProxyHops" | "trustedProxyCidrs">,
  ctx: any,
) {
  return resolveTrustedKoaRequestIp(config, ctx);
}

function createTokenRateLimitKeys(identity: TokenRateLimitIdentity) {
  const scope = `oidc:token:${identity.source}`;
  const keys = [
    `${scope}:client:${identity.clientId}`,
    `${scope}:ip:${identity.ip}`,
    `${scope}:client-ip:${identity.clientId}:${identity.ip}`,
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
  const responseError =
    typeof ctx.body?.error === "string" ? ctx.body.error : undefined;
  return (
    responseError === "invalid_request" || responseError === "invalid_client"
  );
}

function resolveClientRateLimitSource(
  clientAuthMethod: unknown,
): Extract<TokenRateLimitIdentitySource, "client_secret_basic" | "none"> {
  return clientAuthMethod === "none" ? "none" : "client_secret_basic";
}

async function evaluateTokenRateLimit(
  config: StaticConfig,
  rateLimitService: RateLimitService,
  ctx: any,
  identity: TokenRateLimitIdentity,
) {
  const appliedKeys: Set<string> = (ctx.state.tokenRateLimitAppliedKeys ??=
    new Set<string>());
  try {
    for (const key of createTokenRateLimitKeys(identity)) {
      if (appliedKeys.has(key)) {
        continue;
      }
      const decision = await rateLimitService.consume(
        key,
        config.tokenRateLimitMax,
        config.tokenRateLimitWindowSeconds,
      );
      appliedKeys.add(key);
      if (!decision.allowed) {
        return new TokenRateLimitError(
          429,
          "rate_limited",
          "token endpoint rate limit exceeded",
          decision.retryAfterSeconds,
        );
      }
    }
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      return new TokenRateLimitError(
        503,
        "service_unavailable",
        "rate limiting backend is unavailable",
        60,
      );
    }
    throw error;
  }
  return undefined;
}

function resolveSubjectRateLimitIdentity(ctx: any): string | undefined {
  const accountId = ctx.oidc?.session?.accountId;
  return typeof accountId === "string" && accountId.trim().length > 0
    ? accountId
    : undefined;
}

function isTokenRequestPath(pathname: string, tokenPath: string) {
  return pathname === tokenPath || pathname.endsWith(tokenPath);
}

function replyWithTokenError(
  ctx: any,
  tokenRateLimitError: TokenRateLimitError,
) {
  ctx.status = tokenRateLimitError.status;
  ctx.set("Retry-After", String(tokenRateLimitError.retryAfterSeconds));
  ctx.set("Cache-Control", "no-store");
  ctx.body = {
    error: tokenRateLimitError.code,
    error_description: tokenRateLimitError.errorDescription,
  };
}

function createTokenRateLimitMiddleware(
  config: StaticConfig,
  rateLimitService: RateLimitService,
  tokenPath: string,
) {
  return async (ctx: any, next: () => Promise<unknown>) => {
    if (ctx.method !== "POST" || !isTokenRequestPath(ctx.path, tokenPath)) {
      await next();
      return;
    }

    const ip = resolveRequestIp(config, ctx);
    const basicClientId = resolveBasicClientId(ctx);
    if (basicClientId) {
      const basicRateLimitError = await evaluateTokenRateLimit(
        config,
        rateLimitService,
        ctx,
        {
          source: "client_secret_basic",
          clientId: basicClientId,
          ip,
        },
      );
      if (basicRateLimitError) {
        replyWithTokenError(ctx, basicRateLimitError);
        return;
      }
      ctx.state.tokenRateLimitClientIdentitySeen = true;
    }

    await next();

    const resolvedClientId = normalizeClientId(ctx.oidc?.client?.clientId);
    if (
      ctx.state.tokenRateLimitClientIdentitySeen ||
      resolvedClientId ||
      !shouldRateLimitAnonymousTokenResponse(ctx)
    ) {
      return;
    }
    const anonymousRateLimitError = await evaluateTokenRateLimit(
      config,
      rateLimitService,
      ctx,
      {
        source: "anonymous",
        clientId: "unauthenticated",
        ip,
      },
    );
    if (anonymousRateLimitError) {
      replyWithTokenError(ctx, anonymousRateLimitError);
    }
  };
}

function wrapTokenGrantHandlersWithRateLimit(
  provider: RawOidcProvider,
  config: StaticConfig,
  rateLimitService: RateLimitService,
) {
  wrapGrantHandlers(provider, async (handler, ctx) => {
    const clientId = normalizeClientId(ctx.oidc?.client?.clientId);
    if (clientId) {
      const subjectId = resolveSubjectRateLimitIdentity(ctx);
      const clientRateLimitError = await evaluateTokenRateLimit(
        config,
        rateLimitService,
        ctx,
        {
          source: resolveClientRateLimitSource(
            ctx.oidc.client.clientAuthMethod,
          ),
          clientId,
          ip: resolveRequestIp(config, ctx),
          ...(subjectId ? { subjectId } : {}),
        },
      );
      if (clientRateLimitError) {
        replyWithTokenError(ctx, clientRateLimitError);
        return;
      }
    }
    return handler(ctx);
  });
}

function installTokenRateLimitMiddleware(
  provider: RawOidcProvider,
  config: StaticConfig,
  rateLimitService: RateLimitService,
) {
  const tokenPath = provider.pathFor("token");
  provider.use(
    createTokenRateLimitMiddleware(config, rateLimitService, tokenPath),
  );
  wrapTokenGrantHandlersWithRateLimit(provider, config, rateLimitService);
}

export function computeSessionTtlSeconds(
  session: SessionTtlState | undefined,
  config: Pick<StaticConfig, "sessionIdleTtlSeconds" | "sessionTtlSeconds">,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const loginTs = parseEpochSeconds(session?.loginTs);
  const issuedAt = parseEpochSeconds(session?.iat);
  const absoluteAnchor = loginTs ?? issuedAt ?? nowSeconds;
  const elapsed = Math.max(0, nowSeconds - absoluteAnchor);
  const absoluteRemaining = Math.max(0, config.sessionTtlSeconds - elapsed);

  return Math.min(config.sessionIdleTtlSeconds, absoluteRemaining);
}

function asPublicSigningJwk(jwk: SigningJwk): SigningJwk {
  const { d, p, q, dp, dq, qi, oth, priv, k, key_ops, ...publicJwk } =
    jwk as SigningJwk & {
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

function replaceProviderSigningKeyset(
  provider: RawOidcProvider,
  signingJwks: SigningJwk[],
) {
  replaceSigningKeyset(
    provider,
    signingJwks,
    signingJwks.map((jwk) => asPublicSigningJwk(structuredClone(jwk))),
  );
}

function installClientSecretDigestValidation(provider: RawOidcProvider) {
  decorateClientFinder(provider, (providerClient) => {
    if (providerClient && Array.isArray(providerClient.clientSecretDigests)) {
      const digests = providerClient.clientSecretDigests.filter(
        (digest: unknown): digest is string =>
          typeof digest === "string" && digest.startsWith("scrypt$"),
      );
      providerClient.compareClientSecret = async (actual: string) => {
        for (const digest of digests) {
          if (await verifyClientSecretDigest(actual, digest)) return true;
        }
        return false;
      };
    }
  });
}

function startSigningKeyRefreshLoop(
  provider: RawOidcProvider,
  store: SigningKeyRepository,
  refreshIntervalSeconds: number,
  initialSigningJwks: SigningJwk[],
) {
  let currentFingerprint = signingJwksFingerprint(initialSigningJwks);
  const refresh = async () => {
    try {
      const loaded = await store.loadPrivateSigningJwks(["active", "retiring"]);
      const nextSigningJwks = loaded as SigningJwk[];
      if (nextSigningJwks.length === 0) {
        console.error(
          "[oidc-op] signing key refresh skipped: no active or retiring keys available",
        );
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
      console.error(
        "[oidc-op] signing key refresh failed; keeping previous keyset",
        error,
      );
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

const LOGOUT_PAGE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "style-src 'unsafe-inline'",
].join("; ");

function renderLogoutConfirmationPage(form: string) {
  const formWithExplicitLogout = form.includes('name="logout"')
    ? form
    : form.replace(
        "</form>",
        '<input type="hidden" name="logout" value="yes"/></form>',
      );
  return renderBrandedPage(
    "确认退出登录",
    `
      <h1>确认退出登录</h1>
      <p class="hint">请确认是否退出当前登录状态。</p>
      ${formWithExplicitLogout}
      <button form="op.logoutForm" type="submit">继续退出</button>
    `,
  );
}

function renderLogoutSuccessPage() {
  return renderBrandedPage(
    "已退出登录",
    `
      <h1>你已退出登录。</h1>
      <p class="hint">当前认证会话已安全结束。</p>
    `,
  );
}

type SigningKeyModules = Pick<PersistenceModules, "signingKeys" | "jwkCipher">;

async function ensureSigningKey(
  persistence: SigningKeyModules,
  config: StaticConfig,
) {
  const existing = await persistence.signingKeys.listSigningKeys([
    "active",
    "retiring",
  ]);
  if (existing.length > 0) {
    return existing;
  }
  if (!config.autoSeedSigningKey) {
    throw new Error("no signing keys available; run pnpm seed:key");
  }
  const created = await generateSigningKey(persistence);
  return [created];
}

export async function generateSigningKey(
  persistence: SigningKeyModules,
): Promise<OidcSigningKeyRecord> {
  const kid = randomId("kid");
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const [publicJwk, privateJwk] = await Promise.all([
    exportJWK(publicKey),
    exportJWK(privateKey),
  ]);
  const now = new Date().toISOString();
  const record: OidcSigningKeyRecord = {
    kid,
    alg: "RS256",
    use: "sig",
    publicJwk: {
      ...publicJwk,
      kid,
      alg: "RS256",
      use: "sig",
    } as SigningJwk,
    privateJwkCiphertext: await persistence.jwkCipher.encryptPrivateJwk({
      ...privateJwk,
      kid,
      alg: "RS256",
      use: "sig",
    } as SigningJwk),
    status: "active",
    createdAt: now,
    activatedAt: now,
  };
  await persistence.signingKeys.upsertSigningKey(record);
  return record;
}

export async function createOidcRuntime(
  config: StaticConfig,
  persistence: PersistenceModules,
  rateLimitService: RateLimitService,
  providedEmailSender?: EmailSender,
  runtimePolicyService?: RuntimePolicyModule,
): Promise<OidcRuntime> {
  await initializeOidcClientsFromConfig(persistence.clients, config);
  await ensureSigningKey(persistence, config);

  const providerRegistry = new ProviderRegistry(
    new Map<string, CampusVerifierProvider>([
      [
        "mock",
        new MockCampusVerifierProvider({
          schoolCode: config.schoolCode,
        }),
      ],
      [
        "cqut",
        new CqutCampusVerifierProvider({
          schoolCode: config.schoolCode,
          providerTimeoutMs: config.providerTimeoutMs,
          providerTotalTimeoutMs: config.providerTotalTimeoutMs,
          uisBaseUrl: config.cqutUisBaseUrl,
          casApplicationCode: config.cqutCasApplicationCode,
          casServiceUrl: config.cqutCasServiceUrl,
        }),
      ],
    ]),
  );
  const identityLinkService = new IdentityLinkService(persistence.identity);
  const subjectProfileService = new SubjectProfileService(persistence.identity);
  if (!runtimePolicyService) {
    throw new Error("runtime policy service is required");
  }
  const runtimePolicyModule = runtimePolicyService;
  const emailSender =
    providedEmailSender ?? new RuntimeEmailSender(runtimePolicyModule);
  const interactiveAuthenticator = new InteractiveAuthenticatorService(
    providerRegistry,
    identityLinkService,
    subjectProfileService,
    persistence.identity,
  );

  const initialSigningJwks =
    await persistence.signingKeys.loadPrivateSigningJwks([
      "active",
      "retiring",
    ]);
  if (initialSigningJwks.length === 0) {
    throw new Error("no signing keys available after initialization");
  }
  const jwks = { keys: initialSigningJwks };
  const sessionCookieName = config.cookieSecure ? "__Host-op_sid" : "op_sid";
  const provider = new Provider(normalizeIssuer(config.issuer), {
    adapter: createAdapter(persistence),
    jwks,
    clientAuthMethods: ["client_secret_basic", "none"],
    responseTypes: ["code"],
    pkce: {
      required() {
        return true;
      },
    },
    claims: {
      openid: ["sub"],
      profile: ["preferred_username", "name"],
      email: ["email", "email_verified"],
      student: ["status"],
    },
    clientDefaults: {
      token_endpoint_auth_method: "client_secret_basic",
    },
    cookies: {
      keys: config.cookieKeys,
      names: {
        session: sessionCookieName,
        interaction: "_interaction",
        resume: "_interaction_resume",
      },
      long: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: config.cookieSecure,
      },
      short: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: config.cookieSecure,
      },
    },
    discovery: {
      claims_supported: [...OIDC_CLAIMS],
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
          ctx.set("Content-Security-Policy", LOGOUT_PAGE_CSP);
          ctx.set("X-Frame-Options", "DENY");
          ctx.set("X-Content-Type-Options", "nosniff");
          ctx.set("Referrer-Policy", "no-referrer");
          ctx.body = renderLogoutConfirmationPage(form);
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
          ctx.set("Content-Security-Policy", LOGOUT_PAGE_CSP);
          ctx.set("X-Frame-Options", "DENY");
          ctx.set("X-Content-Type-Options", "nosniff");
          ctx.set("Referrer-Policy", "no-referrer");
          if (redirectUri) {
            // oidc-provider validates the URI against the client's registered
            // post_logout_redirect_uris before this hook runs; parse defensively
            // so a malformed value degrades to the success page, not a 500.
            let target: URL | undefined;
            try {
              target = new URL(redirectUri);
            } catch {
              target = undefined;
            }
            if (target) {
              if (state) {
                target.searchParams.set("state", state);
              }
              ctx.redirect(target.toString());
              return;
            }
          }

          ctx.type = "html";
          ctx.body = renderLogoutSuccessPage();
        },
      },
    },
    extraClientMetadata: {
      properties: ["clientSecretDigests", "allowRefreshTokenForPublicClient"],
      validator() {},
    },
    findAccount: async (_ctx: any, sub: string) => {
      const principal =
        await persistence.identity.findPrincipalBySubjectId(sub);
      if (!principal) {
        return undefined;
      }
      return {
        accountId: sub,
        async claims(_use: any, scope: string) {
          const grantedScopes = new Set(parseScope(scope));
          const claims: Record<string, unknown> = {
            sub,
          };
          if (grantedScopes.has("profile")) {
            claims["preferred_username"] = principal.preferredUsername;
            claims["name"] = `User-${principal.schoolUid}`;
          }
          if (
            grantedScopes.has("email") &&
            principal.email &&
            principal.emailVerified
          ) {
            claims["email"] = principal.email;
            claims["email_verified"] = true;
          }
          if (grantedScopes.has("student")) {
            claims["status"] = normalizeStatusClaim(principal.studentStatus);
          }
          return claims;
        },
      };
    },
    interactions: {
      url(_ctx: any, interaction: { uid: string }) {
        return `/interaction/${interaction.uid}`;
      },
    },
    issueRefreshToken(_ctx: any, client: any, code: any) {
      if (!client.grantTypeAllowed("refresh_token")) {
        return false;
      }
      if (
        client.tokenEndpointAuthMethod === "none" &&
        client.metadata().allowRefreshTokenForPublicClient !== true
      ) {
        return false;
      }
      return code.scopes.has("offline_access");
    },
    loadExistingGrant: async (ctx: any) => {
      const grantId =
        ctx.oidc.result?.consent?.grantId ??
        ctx.oidc.session?.grantIdFor(ctx.oidc.client.clientId);
      if (grantId) {
        return ctx.oidc.provider.Grant.find(grantId);
      }
      return undefined;
    },
    renderError(ctx: any, out: Record<string, unknown>) {
      console.error("[oidc-op] provider renderError", out);
      ctx.type = "html";
      ctx.set("Cache-Control", "no-store");
      ctx.body = renderBrandedPage(
        "认证请求失败",
        `
          <h1>认证请求失败</h1>
          <p class="error">${escapeHtml("认证请求未能完成，请刷新后重试。")}</p>
        `,
      );
    },
    rotateRefreshToken() {
      return true;
    },
    routes: {
      authorization: "/auth",
      token: "/token",
      userinfo: "/userinfo",
      jwks: "/jwks",
      end_session: "/session/end",
    },
    scopes: [...OIDC_SCOPES],
    subjectTypes: ["public"],
    ttl: {
      AccessToken: () => config.accessTokenTtlSeconds,
      AuthorizationCode: () => config.authorizationCodeTtlSeconds,
      Grant: () => config.grantTtlSeconds,
      IdToken: () => config.idTokenTtlSeconds,
      Interaction: () => config.interactionTtlSeconds,
      RefreshToken: () => config.refreshTokenTtlSeconds,
      Session: (_ctx: any, session: SessionTtlState) =>
        computeSessionTtlSeconds(session, {
          sessionIdleTtlSeconds: config.sessionIdleTtlSeconds,
          sessionTtlSeconds: config.sessionTtlSeconds,
        }),
    },
  });
  provider.proxy = true;
  installClientSecretDigestValidation(provider);
  const stopSigningKeyRefresh = startSigningKeyRefreshLoop(
    provider,
    persistence.signingKeys,
    config.signingKeyRefreshIntervalSeconds,
    initialSigningJwks as SigningJwk[],
  );

  installTokenRateLimitMiddleware(provider, config, rateLimitService);

  return {
    middleware: provider.callback(),
    interactions: createInteractionPort(provider),
    interactiveAuthenticator,
    subjectProfileService,
    emailSender,
    runtimePolicy: runtimePolicyModule,
    async close() {
      await stopSigningKeyRefresh();
    },
  };
}
