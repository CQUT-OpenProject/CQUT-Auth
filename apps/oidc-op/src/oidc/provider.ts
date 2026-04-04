import { timingSafeEqual } from "node:crypto";
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
import type { OidcOpConfig } from "../config.js";
import type { OidcStore, OidcClientRecord, OidcSigningKeyRecord } from "../persistence/store.js";
import { createAdapter } from "./adapter.js";
import { randomId, parseScope, escapeHtml, sha256 } from "../utils.js";

export type OidcServices = {
  provider: any;
  interactiveAuthenticator: InteractiveAuthenticatorService;
  subjectProfileService: SubjectProfileService;
};

type SigningJwk = JsonWebKey & {
  kid: string;
  alg: string;
  use: string;
};

function providerClientMetadata(client: OidcClientRecord) {
  const metadata: Record<string, unknown> = {
    client_id: client.clientId,
    application_type: client.applicationType === "native" ? "native" : "web",
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    scope: client.scopeWhitelist.join(" "),
    clientSecretHash: client.clientSecretHash
  };
  if (client.clientSecretHash) {
    metadata["client_secret"] = client.clientSecretHash;
    metadata["client_secret_expires_at"] = 0;
  }
  return metadata;
}

function constantTimeHashMatch(actual: string, expectedHash: string): boolean {
  const actualHash = sha256(actual);
  const left = Buffer.from(actualHash, "utf8");
  const right = Buffer.from(expectedHash, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function normalizeIssuer(issuer: string): string {
  return issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
}

function renderAutoLogoutPage(form: string) {
  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>Signing Out</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body>
      ${form}
      <script>document.getElementById("op.logoutForm")?.submit();</script>
      <noscript><button form="op.logoutForm" type="submit" name="logout" value="yes">Continue logout</button></noscript>
    </body>
  </html>`;
}

async function ensureSigningKey(store: OidcStore, config: OidcOpConfig) {
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

export async function generateSigningKey(store: OidcStore): Promise<OidcSigningKeyRecord> {
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
    privateJwkCiphertext: store.encryptPrivateJwk({
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

export async function seedDemoClient(store: OidcStore, config: OidcOpConfig) {
  if (!config.demoClientEnabled) {
    return;
  }
  const now = new Date().toISOString();
  await store.upsertOidcClient({
    clientId: config.demoClientId,
    clientSecretHash: sha256(config.demoClientSecret),
    applicationType: "web",
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUris: [config.demoRedirectUri],
    postLogoutRedirectUris: [config.demoPostLogoutRedirectUri],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopeWhitelist: [...OIDC_SCOPES],
    requirePkce: true,
    status: "active",
    createdAt: now,
    updatedAt: now
  });
}

export async function createOidcServices(config: OidcOpConfig, store: OidcStore): Promise<OidcServices> {
  await seedDemoClient(store, config);
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
          providerTotalTimeoutMs: config.providerTotalTimeoutMs
        })
      ]
    ]),
    config.authProvider
  );
  const identityLinkService = new IdentityLinkService(store);
  const subjectProfileService = new SubjectProfileService(store);
  const interactiveAuthenticator = new InteractiveAuthenticatorService(
    providerRegistry,
    identityLinkService,
    subjectProfileService,
    store
  );

  const clients = (await store.listActiveOidcClients()).map(providerClientMetadata);
  const jwks = { keys: await store.loadPrivateSigningJwks(["active", "retiring"]) };
  const sessionCookieName = config.cookieSecure ? "__Host-op_sid" : "op_sid";
  const provider = new Provider(normalizeIssuer(config.issuer), {
    adapter: createAdapter(store),
    clients,
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
      student: ["school", "student_status"]
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
        secure: config.cookieSecure,
        maxAge: config.sessionTtlSeconds * 1000
      },
      short: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: config.cookieSecure,
        maxAge: config.interactionTtlSeconds * 1000
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
        }
      }
    },
    extraClientMetadata: {
      properties: ["clientSecretHash"],
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
          if (grantedScopes.has("email") && principal.email) {
            claims["email"] = principal.email;
            claims["email_verified"] = principal.emailVerified;
          }
          if (grantedScopes.has("student")) {
            claims["school"] = principal.school;
            claims["student_status"] = principal.studentStatus;
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
      const grant = sessionGrantId ? await ctx.oidc.provider.Grant.find(sessionGrantId) : new ctx.oidc.provider.Grant({
        accountId: ctx.oidc.session.accountId,
        clientId: ctx.oidc.client.clientId
      });
      grant.addOIDCScope(ctx.oidc.params.scope ?? "");
      await grant.save();
      return grant;
    },
    renderError(ctx: any, out: Record<string, unknown>) {
      ctx.type = "html";
      ctx.set("Cache-Control", "no-store");
      ctx.body = `<!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><title>OIDC Error</title></head>
        <body>
          <h1>OIDC Error</h1>
          ${Object.entries(out)
            .map(([key, value]) => `<p><strong>${escapeHtml(key)}</strong>: ${escapeHtml(String(value))}</p>`)
            .join("")}
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
      Session: () => config.sessionTtlSeconds
    }
  });

  for (const client of await store.listActiveOidcClients()) {
    const providerClient = await provider.Client.find(client.clientId);
    if (providerClient && client.clientSecretHash) {
      Object.assign(providerClient, {
        clientSecretHash: client.clientSecretHash
      });
      providerClient.compareClientSecret = (actual: string) =>
        constantTimeHashMatch(actual, client.clientSecretHash as string);
    }
  }

  return {
    provider,
    interactiveAuthenticator,
    subjectProfileService
  };
}
