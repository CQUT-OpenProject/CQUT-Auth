import { randomBytes } from "node:crypto";
import { createClientSecretDigest } from "../crypto.js";
import {
  ClientValidationError,
  validateManagedClientConfiguration,
  type ManagedClientType,
} from "../oidc/client-config.js";
import type {
  ClientLifecycleStatus,
  ClientRevisionStatus,
  ManagedOidcClientRecord,
  OidcClientAuditRecord,
  OidcClientRecord,
  OidcClientRepository,
  OidcClientRevisionRecord,
  RevisionMutationResult,
} from "../persistence/contracts.js";
import { base64Url, randomId } from "../utils.js";

export type ClientActor = {
  subjectId: string;
  isAdmin: boolean;
  sourceIp?: string;
};

export type PublicClientRevision = {
  revisionId: number;
  revisionNumber: number;
  status: ClientRevisionStatus;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopeWhitelist: string[];
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type PublicOidcClient = {
  clientId: string;
  displayName: string;
  description: string;
  ownerSubjectId: string | null;
  clientType: ManagedClientType;
  lifecycleStatus: ClientLifecycleStatus;
  activeRevision: PublicClientRevision | null;
  proposedRevision: PublicClientRevision | null;
  createdAt: string;
  updatedAt: string;
  clientVersion: number;
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

const configurationFields = [
  "redirectUris",
  "postLogoutRedirectUris",
  "scopeWhitelist",
] as const;
const createFields = [
  "clientType",
  "displayName",
  "description",
  ...configurationFields,
] as const;

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
    if (viewAll && !actor.isAdmin) this.denyAdmin();
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
    const client: OidcClientRecord = {
      clientId,
      clientSecretDigest: digest,
      displayName: configuration.displayName,
      description: configuration.description,
      ownerSubjectId: actor.subjectId,
      clientType: configuration.clientType,
      autoConsent: false,
      lifecycleStatus: "draft",
      activeRevisionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    };
    const revision: OidcClientRevisionRecord = {
      revisionId: 0,
      clientId,
      revisionNumber: 1,
      status: "draft",
      redirectUris: configuration.redirectUris,
      postLogoutRedirectUris: configuration.postLogoutRedirectUris,
      scopeWhitelist: configuration.scopeWhitelist,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    };
    const audits = [
      this.audit(
        actor,
        clientId,
        "client.created",
        ["clientType", "displayName", "description"],
        timestamp,
        {
          newClientStatus: "draft",
        },
      ),
      this.audit(
        actor,
        clientId,
        "revision.created",
        configurationFields,
        timestamp,
        {
          newRevisionStatus: "draft",
        },
      ),
    ];
    if (secret)
      audits.push(
        this.audit(actor, clientId, "client.secret_generated", [], timestamp),
      );
    const created = await this.repository.createOidcClient(
      client,
      revision,
      audits,
      actor.isAdmin && this.adminQuotaExempt
        ? undefined
        : {
            maxNonDisabledClients: this.maxClientsPerOwner,
            maxPendingClients: this.maxPendingClientsPerOwner,
          },
    );
    if (!created)
      throw new ClientManagementError(
        409,
        "client_quota_exceeded",
        "client quota exceeded for this account",
      );
    return {
      client: toPublicClient(created),
      ...(secret ? { clientSecret: secret } : {}),
    };
  }

  async update(actor: ClientActor, clientId: string, raw: unknown) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, [
      "clientVersion",
      "displayName",
      "description",
    ]);
    const current = await this.requireAccessible(actor, clientId);
    this.requireEnabled(current);
    const clientVersion = this.parseVersion(
      body["clientVersion"],
      "clientVersion",
    );
    const displayName =
      body["displayName"] === undefined
        ? current.client.displayName
        : this.parseText(body["displayName"], "displayName", 1, 100);
    const description =
      body["description"] === undefined
        ? current.client.description
        : this.parseText(body["description"], "description", 0, 1000);
    const changedFields = [
      ...(displayName !== current.client.displayName ? ["displayName"] : []),
      ...(description !== current.client.description ? ["description"] : []),
    ];
    if (!changedFields.length)
      throw new ClientManagementError(
        400,
        "invalid_request",
        "at least one client field must change",
      );
    const timestamp = this.now().toISOString();
    const updated = await this.repository.updateOidcClientMetadata(
      clientId,
      { displayName, description, updatedAt: timestamp },
      clientVersion,
      this.audit(actor, clientId, "client.updated", changedFields, timestamp),
    );
    return toPublicClient(this.requireUpdated(updated));
  }

  async saveRevision(actor: ClientActor, clientId: string, raw: unknown) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, [
      "revisionId",
      "revisionVersion",
      ...configurationFields,
    ]);
    const current = await this.requireAccessible(actor, clientId);
    this.requireEnabled(current);
    if (current.proposedRevision?.status === "pending") {
      throw new ClientManagementError(
        409,
        "invalid_revision_state",
        "pending revisions must be withdrawn before editing",
      );
    }
    const base = current.proposedRevision ?? current.activeRevision;
    if (!base)
      throw new ClientManagementError(
        409,
        "invalid_revision_state",
        "client has no editable revision",
      );
    const configuration = this.validate({
      clientType: current.client.clientType,
      displayName: current.client.displayName,
      description: current.client.description,
      ...Object.fromEntries(
        configurationFields.map((field) => [
          field,
          body[field] === undefined ? base[field] : body[field],
        ]),
      ),
    });
    const changedFields = configurationFields.filter(
      (field) =>
        JSON.stringify(configuration[field]) !== JSON.stringify(base[field]),
    );
    if (!changedFields.length)
      throw new ClientManagementError(
        400,
        "invalid_request",
        "at least one revision field must change",
      );
    const timestamp = this.now().toISOString();
    const updateDraft = current.proposedRevision?.status === "draft";
    if (updateDraft) {
      const revisionId = this.parseVersion(body["revisionId"], "revisionId");
      const revisionVersion = this.parseVersion(
        body["revisionVersion"],
        "revisionVersion",
      );
      if (revisionId !== current.proposedRevision!.revisionId) this.conflict();
      const next = this.revisionFrom(
        configuration,
        clientId,
        current.proposedRevision!.revisionNumber,
        "draft",
        timestamp,
      );
      const updated = await this.repository.saveOidcClientRevision(
        clientId,
        next,
        revisionId,
        revisionVersion,
        [
          this.audit(
            actor,
            clientId,
            "revision.updated",
            changedFields,
            timestamp,
          ),
        ],
      );
      return toPublicClient(this.requireRevisionUpdated(updated));
    }
    const nextStatus: ClientRevisionStatus =
      current.client.lifecycleStatus === "active" &&
      current.proposedRevision?.status !== "rejected"
        ? "pending"
        : "draft";
    const revisionNumber =
      Math.max(
        current.activeRevision?.revisionNumber ?? 0,
        current.proposedRevision?.revisionNumber ?? 0,
      ) + 1;
    const next = this.revisionFrom(
      configuration,
      clientId,
      revisionNumber,
      nextStatus,
      timestamp,
    );
    const audits = [
      this.audit(
        actor,
        clientId,
        "revision.created",
        changedFields,
        timestamp,
        { newRevisionStatus: nextStatus },
      ),
      ...(nextStatus === "pending"
        ? [
            this.audit(actor, clientId, "revision.submitted", [], timestamp, {
              previousRevisionStatus: "draft",
              newRevisionStatus: "pending",
            }),
          ]
        : []),
    ];
    const updated = await this.repository.saveOidcClientRevision(
      clientId,
      next,
      null,
      null,
      audits,
      nextStatus === "pending" && !(actor.isAdmin && this.adminQuotaExempt)
        ? this.maxPendingClientsPerOwner
        : undefined,
    );
    return toPublicClient(this.requireRevisionUpdated(updated));
  }

  async submit(actor: ClientActor, clientId: string, raw: unknown) {
    return this.transitionOwned(
      actor,
      clientId,
      raw,
      "draft",
      "pending",
      "revision.submitted",
    );
  }

  async withdraw(actor: ClientActor, clientId: string, raw: unknown) {
    return this.transitionOwned(
      actor,
      clientId,
      raw,
      "pending",
      "draft",
      "revision.withdrawn",
    );
  }

  async disable(actor: ClientActor, clientId: string, raw: unknown) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["clientVersion"]);
    const current = await this.requireAccessible(actor, clientId);
    this.requireEnabled(current);
    const timestamp = this.now().toISOString();
    const updated = await this.repository.disableOidcClient(
      clientId,
      this.parseVersion(body["clientVersion"], "clientVersion"),
      timestamp,
      [
        this.audit(
          actor,
          clientId,
          "client.disabled",
          ["lifecycleStatus"],
          timestamp,
          {
            previousClientStatus: current.client.lifecycleStatus,
            newClientStatus: "disabled",
          },
        ),
        ...(current.proposedRevision?.status === "draft" ||
        current.proposedRevision?.status === "pending"
          ? [
              this.audit(actor, clientId, "revision.cancelled", [], timestamp, {
                previousRevisionStatus: current.proposedRevision.status,
                newRevisionStatus: "cancelled",
              }),
            ]
          : []),
      ],
    );
    return toPublicClient(this.requireUpdated(updated));
  }

  async approve(actor: ClientActor, clientId: string, raw: unknown) {
    this.requireAdmin(actor);
    const { current, revisionId, revisionVersion } = await this.reviewInput(
      clientId,
      raw,
      false,
    );
    const timestamp = this.now().toISOString();
    const updated = await this.repository.approveOidcClientRevision(
      clientId,
      revisionId,
      revisionVersion,
      [
        this.audit(actor, clientId, "revision.approved", [], timestamp, {
          previousRevisionStatus: "pending",
          newRevisionStatus: "approved",
        }),
        this.audit(
          actor,
          clientId,
          "revision.activated",
          configurationFields,
          timestamp,
          {
            previousClientStatus: current.client.lifecycleStatus,
            newClientStatus: "active",
          },
        ),
      ],
    );
    return toPublicClient(this.requireUpdated(updated));
  }

  async reject(actor: ClientActor, clientId: string, raw: unknown) {
    this.requireAdmin(actor);
    const { revisionId, revisionVersion, body } = await this.reviewInput(
      clientId,
      raw,
      true,
    );
    const reason = this.parseText(body["reason"], "reason", 1, 500);
    const timestamp = this.now().toISOString();
    const updated = await this.repository.transitionOidcClientRevision(
      clientId,
      revisionId,
      revisionVersion,
      "rejected",
      reason,
      {
        ...this.audit(actor, clientId, "revision.rejected", [], timestamp, {
          previousRevisionStatus: "pending",
          newRevisionStatus: "rejected",
        }),
        reason,
      },
    );
    return toPublicClient(this.requireRevisionUpdated(updated));
  }

  private async transitionOwned(
    actor: ClientActor,
    clientId: string,
    raw: unknown,
    from: ClientRevisionStatus,
    to: ClientRevisionStatus,
    action: OidcClientAuditRecord["action"],
  ) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["revisionId", "revisionVersion"]);
    const current = await this.requireAccessible(actor, clientId);
    this.requireEnabled(current);
    const revision = current.proposedRevision;
    if (!revision || revision.status !== from)
      throw new ClientManagementError(
        409,
        "invalid_revision_state",
        `only ${from} revisions can be transitioned`,
      );
    const revisionId = this.parseVersion(body["revisionId"], "revisionId");
    if (revisionId !== revision.revisionId) this.conflict();
    const timestamp = this.now().toISOString();
    const updated = await this.repository.transitionOidcClientRevision(
      clientId,
      revisionId,
      this.parseVersion(body["revisionVersion"], "revisionVersion"),
      to,
      undefined,
      this.audit(actor, clientId, action, [], timestamp, {
        previousRevisionStatus: from,
        newRevisionStatus: to,
      }),
      to === "pending" && !(actor.isAdmin && this.adminQuotaExempt)
        ? this.maxPendingClientsPerOwner
        : undefined,
    );
    return toPublicClient(this.requireRevisionUpdated(updated));
  }

  private async reviewInput(clientId: string, raw: unknown, reason: boolean) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(
      body,
      reason
        ? ["revisionId", "revisionVersion", "reason"]
        : ["revisionId", "revisionVersion"],
    );
    const current = await this.requireExisting(clientId);
    if (current.client.lifecycleStatus === "disabled")
      throw new ClientManagementError(
        409,
        "invalid_client_state",
        "disabled clients cannot be reviewed",
      );
    const revisionId = this.parseVersion(body["revisionId"], "revisionId");
    const revisionVersion = this.parseVersion(
      body["revisionVersion"],
      "revisionVersion",
    );
    if (
      !current.proposedRevision ||
      current.proposedRevision.status !== "pending" ||
      current.proposedRevision.revisionId !== revisionId
    ) {
      throw new ClientManagementError(
        409,
        "invalid_revision_state",
        "only the current pending revision can be reviewed",
      );
    }
    return { current, revisionId, revisionVersion, body };
  }

  private revisionFrom(
    configuration: ReturnType<ClientManagementService["validate"]>,
    clientId: string,
    revisionNumber: number,
    status: ClientRevisionStatus,
    timestamp: string,
  ): OidcClientRevisionRecord {
    return {
      revisionId: 0,
      clientId,
      revisionNumber,
      status,
      redirectUris: configuration.redirectUris,
      postLogoutRedirectUris: configuration.postLogoutRedirectUris,
      scopeWhitelist: configuration.scopeWhitelist,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    };
  }

  private validate(raw: unknown) {
    try {
      return validateManagedClientConfiguration(raw, this.appEnv);
    } catch (error) {
      if (error instanceof ClientValidationError)
        throw new ClientManagementError(
          400,
          "invalid_client_metadata",
          error.message,
          error.field,
        );
      throw error;
    }
  }

  private async requireAccessible(actor: ClientActor, clientId: string) {
    const managed = await this.requireExisting(clientId);
    if (!actor.isAdmin && managed.client.ownerSubjectId !== actor.subjectId)
      throw new ClientManagementError(404, "not_found", "client not found");
    return managed;
  }

  private async requireExisting(clientId: string) {
    const managed = await this.repository.findManagedOidcClient(clientId);
    if (!managed)
      throw new ClientManagementError(404, "not_found", "client not found");
    return managed;
  }

  private requireEnabled(managed: ManagedOidcClientRecord) {
    if (managed.client.lifecycleStatus === "disabled")
      throw new ClientManagementError(
        409,
        "invalid_client_state",
        "disabled clients cannot be modified",
      );
  }

  private requireAdmin(actor: ClientActor) {
    if (!actor.isAdmin) this.denyAdmin();
  }

  private denyAdmin(): never {
    throw new ClientManagementError(
      403,
      "access_denied",
      "administrator access is required",
    );
  }

  private requireUpdated(value: ManagedOidcClientRecord | null) {
    if (!value) this.conflict();
    return value;
  }

  private requireRevisionUpdated(result: RevisionMutationResult) {
    if (result.status === "pending_quota_exceeded")
      throw new ClientManagementError(
        409,
        "pending_revision_quota_exceeded",
        "pending revision quota exceeded for this account",
      );
    if (result.status === "version_conflict") this.conflict();
    return result.client;
  }

  private conflict(): never {
    throw new ClientManagementError(
      409,
      "version_conflict",
      "client revision was modified; reload and retry",
    );
  }

  private requireObject(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new ClientManagementError(
        400,
        "invalid_request",
        "request body must be an object",
      );
    return raw as Record<string, unknown>;
  }

  private assertAllowedKeys(raw: unknown, allowed: readonly string[]) {
    const body = this.requireObject(raw);
    const allowedKeys = new Set(allowed);
    const unexpected = Object.keys(body).find((key) => !allowedKeys.has(key));
    if (unexpected)
      throw new ClientManagementError(
        400,
        "invalid_request",
        `unsupported request field: ${unexpected}`,
        unexpected,
      );
  }

  private parseVersion(value: unknown, field: string) {
    if (!Number.isInteger(value) || Number(value) <= 0)
      throw new ClientManagementError(
        400,
        "invalid_request",
        `${field} must be a positive integer`,
        field,
      );
    return Number(value);
  }

  private parseText(value: unknown, field: string, min: number, max: number) {
    if (typeof value !== "string")
      throw new ClientManagementError(
        400,
        "invalid_request",
        `${field} must be a string`,
        field,
      );
    const normalized = value.trim();
    if (normalized.length < min || normalized.length > max)
      throw new ClientManagementError(
        400,
        "invalid_request",
        `${field} must contain ${min}-${max} characters`,
        field,
      );
    return normalized;
  }

  private audit(
    actor: ClientActor,
    clientId: string,
    action: OidcClientAuditRecord["action"],
    changedFields: readonly string[],
    createdAt: string,
    states: Partial<
      Pick<
        OidcClientAuditRecord,
        | "previousClientStatus"
        | "newClientStatus"
        | "previousRevisionStatus"
        | "newRevisionStatus"
      >
    > = {},
  ): OidcClientAuditRecord {
    return {
      clientId,
      actorSubjectId: actor.subjectId,
      action,
      changedFields: [...changedFields],
      ...states,
      ...(actor.sourceIp ? { sourceIp: actor.sourceIp } : {}),
      createdAt,
    };
  }
}

export function toPublicClient(
  managed: ManagedOidcClientRecord,
): PublicOidcClient {
  const client = managed.client;
  return {
    clientId: client.clientId,
    displayName: client.displayName,
    description: client.description,
    ownerSubjectId: client.ownerSubjectId,
    clientType: client.clientType,
    lifecycleStatus: client.lifecycleStatus,
    activeRevision: toPublicRevision(managed.activeRevision),
    proposedRevision: toPublicRevision(managed.proposedRevision),
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    clientVersion: client.version,
  };
}

function toPublicRevision(
  revision: OidcClientRevisionRecord | null,
): PublicClientRevision | null {
  return revision
    ? {
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        status: revision.status,
        redirectUris: revision.redirectUris,
        postLogoutRedirectUris: revision.postLogoutRedirectUris,
        scopeWhitelist: revision.scopeWhitelist,
        rejectionReason: revision.rejectionReason ?? null,
        createdAt: revision.createdAt,
        updatedAt: revision.updatedAt,
        version: revision.version,
      }
    : null;
}
