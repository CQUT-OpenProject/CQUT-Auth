import { randomBytes } from "node:crypto";
import { createClientSecretDigest } from "../crypto.js";
import {
  ClientValidationError,
  configurationToProtocolFields,
  validateManagedClientConfiguration,
  type ManagedClientConfiguration,
  type ManagedClientType,
} from "../oidc/client-config.js";
import type {
  OidcClientAuditRecord,
  OidcClientRecord,
  OidcClientRepository,
} from "../persistence/contracts.js";
import { base64Url, randomId } from "../utils.js";

export type ClientActor = {
  subjectId: string;
  isAdmin: boolean;
  sourceIp?: string;
};

export type PublicOidcClient = {
  clientId: string;
  displayName: string;
  description: string;
  ownerSubjectId: string | null;
  clientType: ManagedClientType;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopeWhitelist: string[];
  status: OidcClientRecord["status"];
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export class ClientManagementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ClientManagementError";
  }
}

type ServiceDependencies = {
  now?: () => Date;
  createClientId?: () => string;
  createSecret?: () => string;
  digestSecret?: (secret: string) => Promise<string>;
  maxClientsPerOwner?: number;
  maxPendingClientsPerOwner?: number;
  adminQuotaExempt?: boolean;
};

const editableFields = [
  "displayName",
  "description",
  "redirectUris",
  "postLogoutRedirectUris",
  "scopeWhitelist",
] as const;
const createFields = ["clientType", ...editableFields] as const;
const sensitiveFields = new Set<string>([
  "redirectUris",
  "postLogoutRedirectUris",
  "scopeWhitelist",
]);

export class ClientManagementService {
  private readonly now: () => Date;
  private readonly createClientId: () => string;
  private readonly createSecret: () => string;
  private readonly digestSecret: (secret: string) => Promise<string>;
  private readonly maxClientsPerOwner: number;
  private readonly maxPendingClientsPerOwner: number;
  private readonly adminQuotaExempt: boolean;

  constructor(
    private readonly repository: OidcClientRepository,
    private readonly appEnv: string,
    dependencies: ServiceDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.createClientId =
      dependencies.createClientId ?? (() => randomId("client", 18));
    this.createSecret =
      dependencies.createSecret ?? (() => base64Url(randomBytes(32)));
    this.digestSecret = dependencies.digestSecret ?? createClientSecretDigest;
    this.maxClientsPerOwner = dependencies.maxClientsPerOwner ?? 10;
    this.maxPendingClientsPerOwner =
      dependencies.maxPendingClientsPerOwner ?? 5;
    this.adminQuotaExempt = dependencies.adminQuotaExempt ?? true;
  }

  async list(actor: ClientActor, viewAll = false) {
    if (viewAll && !actor.isAdmin) {
      throw new ClientManagementError(
        403,
        "access_denied",
        "administrator access is required",
      );
    }
    const clients = viewAll
      ? await this.repository.listOidcClients()
      : await this.repository.listOidcClientsByOwner(actor.subjectId);
    return clients.map(toPublicClient);
  }

  async listPending(actor: ClientActor) {
    this.requireAdmin(actor);
    return (await this.repository.listPendingOidcClients()).map(toPublicClient);
  }

  async get(actor: ClientActor, clientId: string) {
    return toPublicClient(await this.requireAccessible(actor, clientId));
  }

  async create(actor: ClientActor, raw: unknown) {
    this.assertAllowedKeys(raw, createFields);
    const configuration = this.validate(raw);
    const clientId = this.createClientId();
    const secret =
      configuration.clientType === "web" ? this.createSecret() : undefined;
    const digest = secret ? await this.digestSecret(secret) : undefined;
    const timestamp = this.now().toISOString();
    const protocol = configurationToProtocolFields(configuration);
    const client: OidcClientRecord = {
      clientId,
      clientSecretDigest: digest,
      displayName: configuration.displayName,
      description: configuration.description,
      ownerSubjectId: actor.subjectId,
      ...protocol,
      redirectUris: configuration.redirectUris,
      postLogoutRedirectUris: configuration.postLogoutRedirectUris,
      scopeWhitelist: configuration.scopeWhitelist,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    };
    const audits: OidcClientAuditRecord[] = [
      this.audit(
        actor,
        clientId,
        "client.created",
        [...createFields],
        undefined,
        "pending",
        timestamp,
      ),
    ];
    if (secret) {
      audits.push(
        this.audit(
          actor,
          clientId,
          "client.secret_generated",
          [],
          undefined,
          undefined,
          timestamp,
        ),
      );
    }
    const created = await this.repository.createOidcClient(
      client,
      audits,
      actor.isAdmin && this.adminQuotaExempt
        ? undefined
        : {
            maxNonDisabledClients: this.maxClientsPerOwner,
            maxPendingClients: this.maxPendingClientsPerOwner,
          },
    );
    if (!created) {
      throw new ClientManagementError(
        409,
        "client_quota_exceeded",
        "client quota exceeded for this account",
      );
    }
    return {
      client: toPublicClient(client),
      ...(secret ? { clientSecret: secret } : {}),
    };
  }

  async update(actor: ClientActor, clientId: string, raw: unknown) {
    const patch = this.requireObject(raw);
    this.assertAllowedKeys(patch, ["version", ...editableFields]);
    const version = this.parseVersion(patch["version"]);
    const current = await this.requireAccessible(actor, clientId);
    if (current.status === "disabled") {
      throw new ClientManagementError(
        409,
        "invalid_client_state",
        "disabled clients cannot be edited",
      );
    }
    const currentConfiguration = configurationFromRecord(current);
    const merged = {
      clientType: currentConfiguration.clientType,
      ...Object.fromEntries(
        editableFields.map((field) => [
          field,
          patch[field] === undefined
            ? currentConfiguration[field]
            : patch[field],
        ]),
      ),
    };
    const configuration = this.validate(merged);
    const changedFields = editableFields.filter(
      (field) =>
        JSON.stringify(configuration[field]) !==
        JSON.stringify(currentConfiguration[field]),
    );
    if (changedFields.length === 0) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        "at least one client field must change",
      );
    }
    const becomesPending = changedFields.some((field) =>
      sensitiveFields.has(field),
    );
    if (current.status === "active" && becomesPending) {
      throw new ClientManagementError(
        409,
        "invalid_client_state",
        "active clients cannot change redirect URIs or scopes; create a new client",
      );
    }
    const nextStatus = current.status === "rejected" ? "draft" : current.status;
    const timestamp = this.now().toISOString();
    const next: OidcClientRecord = {
      ...current,
      ...configurationToProtocolFields(configuration),
      displayName: configuration.displayName,
      description: configuration.description,
      redirectUris: configuration.redirectUris,
      postLogoutRedirectUris: configuration.postLogoutRedirectUris,
      scopeWhitelist: configuration.scopeWhitelist,
      status: nextStatus,
      updatedAt: timestamp,
      version: current.version + 1,
    };
    const updated = await this.repository.updateOidcClient(
      next,
      version,
      this.audit(
        actor,
        clientId,
        "client.updated",
        changedFields,
        current.status,
        nextStatus,
        timestamp,
      ),
    );
    if (!updated) {
      throw new ClientManagementError(
        409,
        "version_conflict",
        "client was modified; reload and retry",
      );
    }
    return toPublicClient(updated);
  }

  async submit(actor: ClientActor, clientId: string, raw: unknown) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["version"]);
    const current = await this.requireAccessible(actor, clientId);
    if (current.status !== "draft") {
      throw new ClientManagementError(
        409,
        "invalid_client_state",
        "only draft clients can be submitted",
      );
    }
    return this.transition(
      actor,
      current,
      this.parseVersion(body["version"]),
      "pending",
      "client.submitted",
    );
  }

  async disable(actor: ClientActor, clientId: string, raw: unknown) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["version"]);
    const version = this.parseVersion(body["version"]);
    const current = await this.requireAccessible(actor, clientId);
    if (current.status === "disabled") {
      throw new ClientManagementError(
        409,
        "invalid_client_state",
        "client is already disabled",
      );
    }
    return this.transition(
      actor,
      current,
      version,
      "disabled",
      "client.disabled",
    );
  }

  async approve(actor: ClientActor, clientId: string, raw: unknown) {
    this.requireAdmin(actor);
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["version"]);
    const current = await this.requireExisting(clientId);
    if (current.status !== "pending") {
      throw new ClientManagementError(
        409,
        "invalid_client_state",
        "only pending clients can be approved",
      );
    }
    return this.transition(
      actor,
      current,
      this.parseVersion(body["version"]),
      "active",
      "client.approved",
    );
  }

  async reject(actor: ClientActor, clientId: string, raw: unknown) {
    this.requireAdmin(actor);
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["version", "reason"]);
    const current = await this.requireExisting(clientId);
    if (current.status !== "pending") {
      throw new ClientManagementError(
        409,
        "invalid_client_state",
        "only pending clients can be rejected",
      );
    }
    const reason =
      body["reason"] === undefined
        ? undefined
        : typeof body["reason"] === "string" &&
            body["reason"].trim().length <= 500
          ? body["reason"].trim()
          : (() => {
              throw new ClientManagementError(
                400,
                "invalid_request",
                "reason must be at most 500 characters",
                "reason",
              );
            })();
    return this.transition(
      actor,
      current,
      this.parseVersion(body["version"]),
      "rejected",
      "client.rejected",
      reason,
    );
  }

  private async transition(
    actor: ClientActor,
    current: OidcClientRecord,
    version: number,
    status: OidcClientRecord["status"],
    action: OidcClientAuditRecord["action"],
    reason?: string,
  ) {
    const timestamp = this.now().toISOString();
    const next = {
      ...current,
      status,
      ...(status === "rejected" ? { rejectionReason: reason } : {}),
      updatedAt: timestamp,
      version: current.version + 1,
    };
    const updated = await this.repository.updateOidcClient(next, version, {
      ...this.audit(
        actor,
        current.clientId,
        action,
        ["status"],
        current.status,
        status,
        timestamp,
      ),
      ...(reason ? { reason } : {}),
    });
    if (!updated) {
      throw new ClientManagementError(
        409,
        "version_conflict",
        "client was modified; reload and retry",
      );
    }
    return toPublicClient(updated);
  }

  private validate(raw: unknown) {
    try {
      return validateManagedClientConfiguration(raw, this.appEnv);
    } catch (error) {
      if (error instanceof ClientValidationError) {
        throw new ClientManagementError(
          400,
          "invalid_client_metadata",
          error.message,
          error.field,
        );
      }
      throw error;
    }
  }

  private async requireAccessible(actor: ClientActor, clientId: string) {
    const client = await this.requireExisting(clientId);
    if (!actor.isAdmin && client.ownerSubjectId !== actor.subjectId) {
      throw new ClientManagementError(404, "not_found", "client not found");
    }
    return client;
  }

  private async requireExisting(clientId: string) {
    const client = await this.repository.findOidcClient(clientId);
    if (!client) {
      throw new ClientManagementError(404, "not_found", "client not found");
    }
    return client;
  }

  private requireAdmin(actor: ClientActor) {
    if (!actor.isAdmin) {
      throw new ClientManagementError(
        403,
        "access_denied",
        "administrator access is required",
      );
    }
  }

  private requireObject(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        "request body must be an object",
      );
    }
    return raw as Record<string, unknown>;
  }

  private assertAllowedKeys(raw: unknown, allowed: readonly string[]) {
    const body = this.requireObject(raw);
    const unexpected = Object.keys(body).filter(
      (key) => !allowed.includes(key),
    );
    if (unexpected.length > 0) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        `unsupported request field: ${unexpected[0]}`,
        unexpected[0],
      );
    }
  }

  private parseVersion(value: unknown) {
    if (!Number.isInteger(value) || Number(value) <= 0) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        "version must be a positive integer",
        "version",
      );
    }
    return Number(value);
  }

  private audit(
    actor: ClientActor,
    clientId: string,
    action: OidcClientAuditRecord["action"],
    changedFields: readonly string[],
    previousStatus: OidcClientRecord["status"] | undefined,
    newStatus: OidcClientRecord["status"] | undefined,
    createdAt: string,
  ): OidcClientAuditRecord {
    return {
      clientId,
      actorSubjectId: actor.subjectId,
      action,
      changedFields: [...changedFields],
      ...(previousStatus ? { previousStatus } : {}),
      ...(newStatus ? { newStatus } : {}),
      ...(actor.sourceIp ? { sourceIp: actor.sourceIp } : {}),
      createdAt,
    };
  }
}

export function toPublicClient(client: OidcClientRecord): PublicOidcClient {
  return {
    clientId: client.clientId,
    displayName: client.displayName,
    description: client.description,
    ownerSubjectId: client.ownerSubjectId,
    clientType: client.tokenEndpointAuthMethod === "none" ? "spa" : "web",
    redirectUris: client.redirectUris,
    postLogoutRedirectUris: client.postLogoutRedirectUris,
    scopeWhitelist: client.scopeWhitelist,
    status: client.status,
    rejectionReason: client.rejectionReason ?? null,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    version: client.version,
  };
}

function configurationFromRecord(
  client: OidcClientRecord,
): ManagedClientConfiguration {
  return {
    clientType: client.tokenEndpointAuthMethod === "none" ? "spa" : "web",
    displayName: client.displayName,
    description: client.description,
    redirectUris: client.redirectUris,
    postLogoutRedirectUris: client.postLogoutRedirectUris,
    scopeWhitelist: client.scopeWhitelist,
  };
}
