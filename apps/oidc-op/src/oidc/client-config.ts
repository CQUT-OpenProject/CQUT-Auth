import { readFile } from "node:fs/promises";
import { OIDC_SCOPES, type OidcScope } from "@cqut/shared";
import type { OidcOpConfig } from "../config.js";
import type { OidcClientRecord, OidcPersistence } from "../persistence/contracts.js";

type RawClientsDocument = {
  clients: unknown;
};

type RawClient = {
  clientId?: unknown;
  clientSecretDigest?: unknown;
  applicationType?: unknown;
  tokenEndpointAuthMethod?: unknown;
  redirectUris?: unknown;
  postLogoutRedirectUris?: unknown;
  grantTypes?: unknown;
  responseTypes?: unknown;
  scopeWhitelist?: unknown;
  requirePkce?: unknown;
  autoConsent?: unknown;
  status?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAbsoluteUrl(value: string, key: string, clientId: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`oidc client ${clientId}: ${key} must be an absolute URL`);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function assertHttpsOrTestLoopbackHttp(value: string, key: string, appEnv: string, clientId: string) {
  const parsed = parseAbsoluteUrl(value, key, clientId);
  if (parsed.protocol === "https:") {
    return;
  }
  if (appEnv === "test" && parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return;
  }
  if (appEnv === "test") {
    throw new Error(
      `oidc client ${clientId}: ${key} must use https:// or loopback http://localhost|127.0.0.1 in test`
    );
  }
  throw new Error(`oidc client ${clientId}: ${key} must use https:// when APP_ENV is not test`);
}

function parseString(value: unknown, key: string, clientId: string): string {
  if (typeof value !== "string") {
    throw new Error(`oidc client ${clientId}: ${key} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`oidc client ${clientId}: ${key} must be a non-empty string`);
  }
  return normalized;
}

function parseStringArray(
  value: unknown,
  key: string,
  clientId: string,
  options: { required: boolean; defaultValue?: string[] } = { required: true }
): string[] {
  if (value === undefined) {
    if (options.defaultValue) {
      return options.defaultValue;
    }
    if (options.required) {
      throw new Error(`oidc client ${clientId}: ${key} is required`);
    }
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`oidc client ${clientId}: ${key} must be an array of strings`);
  }
  const parsed = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`oidc client ${clientId}: ${key}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
  if (parsed.length === 0 && options.required) {
    throw new Error(`oidc client ${clientId}: ${key} must contain at least one item`);
  }
  return parsed;
}

function parseBoolean(value: unknown, key: string, clientId: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`oidc client ${clientId}: ${key} must be a boolean`);
  }
  return value;
}

function parseTokenEndpointAuthMethod(value: unknown, clientId: string): OidcClientRecord["tokenEndpointAuthMethod"] {
  if (value === undefined) {
    return "client_secret_basic";
  }
  if (value === "client_secret_basic" || value === "none") {
    return value;
  }
  throw new Error(`oidc client ${clientId}: tokenEndpointAuthMethod must be client_secret_basic or none`);
}

function parseApplicationType(value: unknown, clientId: string): OidcClientRecord["applicationType"] {
  if (value === undefined) {
    return "web";
  }
  if (value === "web" || value === "native" || value === "service") {
    return value;
  }
  throw new Error(`oidc client ${clientId}: applicationType must be web, native, or service`);
}

function parseStatus(value: unknown, clientId: string): OidcClientRecord["status"] {
  if (value === undefined) {
    return "active";
  }
  if (value === "active" || value === "disabled") {
    return value;
  }
  throw new Error(`oidc client ${clientId}: status must be active or disabled`);
}

function parseScopeWhitelist(value: unknown, clientId: string): OidcScope[] {
  const scopes = parseStringArray(value, "scopeWhitelist", clientId, {
    required: true,
    defaultValue: [...OIDC_SCOPES]
  });
  const supported = new Set<string>(OIDC_SCOPES);
  for (const scope of scopes) {
    if (!supported.has(scope)) {
      throw new Error(`oidc client ${clientId}: unsupported scope ${scope}`);
    }
  }
  return scopes as OidcScope[];
}

function parseClient(raw: unknown, appEnv: string, seenClientIds: Set<string>): OidcClientRecord {
  if (!isObject(raw)) {
    throw new Error("each oidc client item must be an object");
  }
  const client = raw as RawClient;
  const clientId = parseString(client.clientId, "clientId", "<unknown>");
  if (seenClientIds.has(clientId)) {
    throw new Error(`duplicate oidc client clientId: ${clientId}`);
  }
  seenClientIds.add(clientId);

  const tokenEndpointAuthMethod = parseTokenEndpointAuthMethod(client.tokenEndpointAuthMethod, clientId);
  const clientSecretDigestRaw = client.clientSecretDigest;
  const clientSecretDigest =
    clientSecretDigestRaw === undefined
      ? undefined
      : parseString(clientSecretDigestRaw, "clientSecretDigest", clientId);

  if (tokenEndpointAuthMethod === "client_secret_basic" && !clientSecretDigest) {
    throw new Error(`oidc client ${clientId}: clientSecretDigest is required for client_secret_basic`);
  }
  if (tokenEndpointAuthMethod === "none" && clientSecretDigest) {
    throw new Error(`oidc client ${clientId}: clientSecretDigest must be omitted when tokenEndpointAuthMethod=none`);
  }
  if (clientSecretDigest && !clientSecretDigest.startsWith("scrypt$")) {
    throw new Error(`oidc client ${clientId}: clientSecretDigest must use scrypt digest format`);
  }

  const redirectUris = parseStringArray(client.redirectUris, "redirectUris", clientId);
  const postLogoutRedirectUris = parseStringArray(
    client.postLogoutRedirectUris,
    "postLogoutRedirectUris",
    clientId
  );
  for (const redirectUri of redirectUris) {
    assertHttpsOrTestLoopbackHttp(redirectUri, "redirectUris", appEnv, clientId);
  }
  for (const postLogoutRedirectUri of postLogoutRedirectUris) {
    assertHttpsOrTestLoopbackHttp(postLogoutRedirectUri, "postLogoutRedirectUris", appEnv, clientId);
  }

  const now = new Date().toISOString();
  return {
    clientId,
    clientSecretDigest,
    applicationType: parseApplicationType(client.applicationType, clientId),
    tokenEndpointAuthMethod,
    redirectUris,
    postLogoutRedirectUris,
    grantTypes: parseStringArray(client.grantTypes, "grantTypes", clientId, {
      required: true,
      defaultValue: ["authorization_code", "refresh_token"]
    }),
    responseTypes: parseStringArray(client.responseTypes, "responseTypes", clientId, {
      required: true,
      defaultValue: ["code"]
    }),
    scopeWhitelist: parseScopeWhitelist(client.scopeWhitelist, clientId),
    requirePkce: parseBoolean(client.requirePkce, "requirePkce", clientId, true),
    autoConsent: parseBoolean(client.autoConsent, "autoConsent", clientId, false),
    status: parseStatus(client.status, clientId),
    createdAt: now,
    updatedAt: now
  };
}

export async function loadOidcClientsFromConfig(config: Pick<OidcOpConfig, "appEnv" | "oidcClientsConfigPath">) {
  let rawText: string;
  try {
    rawText = await readFile(config.oidcClientsConfigPath, "utf8");
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to read OIDC clients config (${config.oidcClientsConfigPath}): ${description}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to parse OIDC clients config (${config.oidcClientsConfigPath}) as JSON: ${description}`
    );
  }
  if (!isObject(parsed)) {
    throw new Error(`OIDC clients config (${config.oidcClientsConfigPath}) must be a JSON object`);
  }
  const document = parsed as RawClientsDocument;
  if (!Array.isArray(document.clients)) {
    throw new Error(`OIDC clients config (${config.oidcClientsConfigPath}) must contain a "clients" array`);
  }
  if (document.clients.length === 0) {
    throw new Error(`OIDC clients config (${config.oidcClientsConfigPath}) must contain at least one client`);
  }
  const seenClientIds = new Set<string>();
  return document.clients.map((entry) => parseClient(entry, config.appEnv, seenClientIds));
}

export async function upsertOidcClientsFromConfig(
  store: OidcPersistence,
  config: Pick<OidcOpConfig, "appEnv" | "oidcClientsConfigPath">
) {
  const clients = await loadOidcClientsFromConfig(config);
  for (const client of clients) {
    await store.upsertOidcClient(client);
  }
  return clients;
}
