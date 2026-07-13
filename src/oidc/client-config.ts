import { readFile } from "node:fs/promises";
import {
  DEFAULT_OIDC_SCOPES,
  OIDC_SCOPES,
  type OidcScope,
} from "../shared/oidc-contracts.js";
import type { OidcOpConfig } from "../config.js";
import type {
  ActiveOidcClientRecord,
  OidcClientAuditRecord,
  OidcPersistence,
} from "../persistence/contracts.js";

export type ManagedClientType = "web" | "spa";

export type ManagedClientConfiguration = {
  clientType: ManagedClientType;
  displayName: string;
  description: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopeWhitelist: OidcScope[];
};

export class ClientValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ClientValidationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseString(
  value: unknown,
  key: string,
  label: string,
  options?: { optional?: boolean; max?: number },
) {
  if (value === undefined && options?.optional) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ClientValidationError(`${label}: ${key} must be a string`, key);
  }
  const normalized = value.trim();
  if (!normalized && !options?.optional) {
    throw new ClientValidationError(
      `${label}: ${key} must be a non-empty string`,
      key,
    );
  }
  if (options?.max && normalized.length > options.max) {
    throw new ClientValidationError(
      `${label}: ${key} must be at most ${options.max} characters`,
      key,
    );
  }
  return normalized;
}

function parseStringArray(
  value: unknown,
  key: string,
  label: string,
  options: { required: boolean; defaultValue?: string[] },
) {
  if (value === undefined && options.defaultValue) {
    return [...options.defaultValue];
  }
  if (!Array.isArray(value)) {
    throw new ClientValidationError(
      `${label}: ${key} must be an array of strings`,
      key,
    );
  }
  const parsed = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ClientValidationError(
        `${label}: ${key}[${index}] must be a non-empty string`,
        key,
      );
    }
    return entry.trim();
  });
  const unique = [...new Set(parsed)];
  if (unique.length === 0 && options.required) {
    throw new ClientValidationError(
      `${label}: ${key} must contain at least one item`,
      key,
    );
  }
  if (unique.length > 20) {
    throw new ClientValidationError(
      `${label}: ${key} must contain at most 20 items`,
      key,
    );
  }
  return unique;
}

function validateUri(
  value: string,
  key: string,
  appEnv: string,
  label: string,
) {
  if (value.includes("*")) {
    throw new ClientValidationError(
      `${label}: ${key} must not contain wildcards`,
      key,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ClientValidationError(
      `${label}: ${key} must be an absolute URL`,
      key,
    );
  }
  if (parsed.hash) {
    throw new ClientValidationError(
      `${label}: ${key} must not contain a fragment`,
      key,
    );
  }
  if (parsed.username || parsed.password) {
    throw new ClientValidationError(
      `${label}: ${key} must not contain credentials`,
      key,
    );
  }
  if (parsed.protocol === "https:") {
    return;
  }
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (appEnv === "test" && parsed.protocol === "http:" && loopback) {
    return;
  }
  throw new ClientValidationError(
    appEnv === "test"
      ? `${label}: ${key} must use https:// or loopback http://localhost|127.0.0.1 in test`
      : `${label}: ${key} must use https:// when APP_ENV is not test`,
    key,
  );
}

function parseScopes(value: unknown, label: string): OidcScope[] {
  const scopes = parseStringArray(value, "scopeWhitelist", label, {
    required: true,
    defaultValue: [...DEFAULT_OIDC_SCOPES],
  });
  const supported = new Set<string>(OIDC_SCOPES);
  for (const scope of scopes) {
    if (!supported.has(scope)) {
      throw new ClientValidationError(
        `${label}: unsupported scope ${scope}`,
        "scopeWhitelist",
      );
    }
  }
  if (!scopes.includes("openid")) {
    throw new ClientValidationError(
      `${label}: scopeWhitelist must include openid`,
      "scopeWhitelist",
    );
  }
  return scopes as OidcScope[];
}

export function validateManagedClientConfiguration(
  raw: unknown,
  appEnv: string,
  label = "oidc client",
): ManagedClientConfiguration {
  if (!isObject(raw)) {
    throw new ClientValidationError(`${label} must be an object`);
  }
  const clientType = raw["clientType"];
  if (clientType !== "web" && clientType !== "spa") {
    throw new ClientValidationError(
      `${label}: clientType must be web or spa`,
      "clientType",
    );
  }
  const redirectUris = parseStringArray(
    raw["redirectUris"],
    "redirectUris",
    label,
    {
      required: true,
    },
  );
  const postLogoutRedirectUris = parseStringArray(
    raw["postLogoutRedirectUris"],
    "postLogoutRedirectUris",
    label,
    { required: false, defaultValue: [] },
  );
  for (const uri of redirectUris) {
    validateUri(uri, "redirectUris", appEnv, label);
  }
  for (const uri of postLogoutRedirectUris) {
    validateUri(uri, "postLogoutRedirectUris", appEnv, label);
  }
  const scopeWhitelist = parseScopes(raw["scopeWhitelist"], label);
  if (clientType === "spa" && scopeWhitelist.includes("offline_access")) {
    throw new ClientValidationError(
      `${label}: SPA clients cannot request offline_access in this release`,
      "scopeWhitelist",
    );
  }
  return {
    clientType,
    displayName: parseString(raw["displayName"], "displayName", label, {
      max: 100,
    }),
    description: parseString(raw["description"], "description", label, {
      optional: true,
      max: 1000,
    }),
    redirectUris,
    postLogoutRedirectUris,
    scopeWhitelist,
  };
}

export function configurationToProtocolFields(
  configuration: ManagedClientConfiguration,
) {
  const confidential = configuration.clientType === "web";
  return {
    applicationType: "web" as const,
    tokenEndpointAuthMethod: confidential
      ? ("client_secret_basic" as const)
      : ("none" as const),
    grantTypes: confidential
      ? ["authorization_code", "refresh_token"]
      : ["authorization_code"],
    responseTypes: ["code"],
    requirePkce: true,
    allowRefreshTokenForPublicClient: false,
    autoConsent: false,
  };
}

function parseBootstrapClient(
  raw: unknown,
  appEnv: string,
  seen: Set<string>,
): ActiveOidcClientRecord {
  if (!isObject(raw)) {
    throw new ClientValidationError("each oidc client item must be an object");
  }
  const clientId = parseString(
    raw["clientId"],
    "clientId",
    "oidc client <unknown>",
    { max: 200 },
  );
  if (seen.has(clientId)) {
    throw new ClientValidationError(
      `duplicate oidc client clientId: ${clientId}`,
      "clientId",
    );
  }
  seen.add(clientId);
  if (
    raw["applicationType"] !== undefined &&
    raw["applicationType"] !== "web"
  ) {
    throw new ClientValidationError(
      `oidc client ${clientId}: only web applicationType is supported`,
    );
  }
  const tokenMethod = raw["tokenEndpointAuthMethod"] ?? "client_secret_basic";
  if (tokenMethod !== "client_secret_basic" && tokenMethod !== "none") {
    throw new ClientValidationError(
      `oidc client ${clientId}: invalid tokenEndpointAuthMethod`,
    );
  }
  const clientType: ManagedClientType = tokenMethod === "none" ? "spa" : "web";
  const configuration = validateManagedClientConfiguration(
    {
      clientType,
      displayName: raw["displayName"] ?? clientId,
      description: raw["description"] ?? "",
      redirectUris: raw["redirectUris"],
      postLogoutRedirectUris: raw["postLogoutRedirectUris"] ?? [],
      scopeWhitelist: raw["scopeWhitelist"],
    },
    appEnv,
    `oidc client ${clientId}`,
  );
  const digest = raw["clientSecretDigest"];
  if (
    clientType === "web" &&
    (typeof digest !== "string" || !digest.startsWith("scrypt$"))
  ) {
    throw new ClientValidationError(
      `oidc client ${clientId}: clientSecretDigest is required and must use scrypt digest format`,
    );
  }
  if (clientType === "spa" && digest !== undefined) {
    throw new ClientValidationError(
      `oidc client ${clientId}: clientSecretDigest must be omitted for SPA clients`,
    );
  }
  const protocol = configurationToProtocolFields(configuration);
  if (
    raw["grantTypes"] !== undefined &&
    JSON.stringify(raw["grantTypes"]) !== JSON.stringify(protocol.grantTypes)
  ) {
    throw new ClientValidationError(
      `oidc client ${clientId}: grantTypes must be ${protocol.grantTypes.join(", ")}`,
      "grantTypes",
    );
  }
  if (
    raw["responseTypes"] !== undefined &&
    JSON.stringify(raw["responseTypes"]) !== JSON.stringify(["code"])
  ) {
    throw new ClientValidationError(
      `oidc client ${clientId}: responseTypes must be code`,
      "responseTypes",
    );
  }
  if (raw["requirePkce"] === false) {
    throw new ClientValidationError(
      `oidc client ${clientId}: requirePkce must be true`,
      "requirePkce",
    );
  }
  if (raw["allowRefreshTokenForPublicClient"] === true) {
    throw new ClientValidationError(
      `oidc client ${clientId}: public client refresh tokens are not supported`,
      "allowRefreshTokenForPublicClient",
    );
  }
  const now = new Date().toISOString();
  const revision = {
    revisionId: 0,
    clientId,
    revisionNumber: 1,
    status: "approved" as const,
    redirectUris: configuration.redirectUris,
    postLogoutRedirectUris: configuration.postLogoutRedirectUris,
    scopeWhitelist: configuration.scopeWhitelist,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  return {
    clientId,
    clientSecretDigests: typeof digest === "string" ? [digest] : [],
    displayName: configuration.displayName,
    description: configuration.description,
    ownerSubjectId: null,
    clientType,
    lifecycleStatus: "active",
    activeRevisionId: 0,
    activeRevision: revision,
    ...protocol,
    redirectUris: configuration.redirectUris,
    postLogoutRedirectUris: configuration.postLogoutRedirectUris,
    scopeWhitelist: configuration.scopeWhitelist,
    autoConsent: raw["autoConsent"] === true,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

export async function loadOidcClientsFromConfig(
  config: Pick<OidcOpConfig, "appEnv" | "oidcClientsConfigPath">,
) {
  let rawText: string;
  try {
    rawText = await readFile(config.oidcClientsConfigPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new Error(
      `failed to read OIDC clients config (${config.oidcClientsConfigPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `failed to parse OIDC clients config (${config.oidcClientsConfigPath}) as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed) || !Array.isArray(parsed["clients"])) {
    throw new Error(
      `OIDC clients config (${config.oidcClientsConfigPath}) must contain a "clients" array`,
    );
  }
  const seen = new Set<string>();
  return parsed["clients"].map((entry) =>
    parseBootstrapClient(entry, config.appEnv, seen),
  );
}

export async function initializeOidcClientsFromConfig(
  store: OidcPersistence,
  config: Pick<OidcOpConfig, "appEnv" | "oidcClientsConfigPath">,
) {
  if ((await store.countOidcClients()) > 0) {
    return { imported: false, count: 0 };
  }
  const clients = await loadOidcClientsFromConfig(config);
  if (clients.length === 0) {
    return { imported: false, count: 0 };
  }
  const now = new Date().toISOString();
  const audits: OidcClientAuditRecord[] = clients.flatMap((client) => [
    {
      clientId: client.clientId,
      actorSubjectId: null,
      action: "client.initialized",
      changedFields: [],
      newClientStatus: "active",
      createdAt: now,
    },
    {
      clientId: client.clientId,
      actorSubjectId: null,
      action: "revision.created",
      changedFields: [
        "redirectUris",
        "postLogoutRedirectUris",
        "scopeWhitelist",
      ],
      newRevisionStatus: "approved",
      createdAt: now,
    },
    {
      clientId: client.clientId,
      actorSubjectId: null,
      action: "revision.activated",
      changedFields: [
        "redirectUris",
        "postLogoutRedirectUris",
        "scopeWhitelist",
      ],
      newClientStatus: "active",
      createdAt: now,
    },
  ]);
  return store.initializeOidcClientsIfEmpty(clients, audits);
}
