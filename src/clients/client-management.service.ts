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
  OidcClientSecretRecord,
  RevisionMutationResult,
} from "../persistence/contracts.js";
import { base64Url, randomId } from "../utils.js";
import {
  ProjectAccessService,
  type ProjectAction,
} from "../projects/project-access.js";

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
  projectId: string;
  displayName: string;
  description: string;
  createdBySubjectId: string | null;
  clientType: ManagedClientType;
  lifecycleStatus: ClientLifecycleStatus;
  activeRevision: PublicClientRevision | null;
  proposedRevision: PublicClientRevision | null;
  secrets: PublicClientSecret[];
  createdAt: string;
  updatedAt: string;
  clientVersion: number;
};

export type PublicClientSecret = {
  secretId: string;
  status: OidcClientSecretRecord["status"];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  version: number;
};

export class ClientManagementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ClientManagementError";
  }
}

type ServiceDependencies = {
  now?: () => Date;
  createClientId?: () => string;
  createSecret?: () => string;
  createSecretId?: () => string;
  digestSecret?: (secret: string) => Promise<string>;
  maxClientsPerProject?: number;
  maxPendingClientsPerProject?: number;
  adminQuotaExempt?: boolean;
  defaultSecretGraceSeconds?: number;
  maxSecretGraceSeconds?: number;
  minimumSecretRotationIntervalSeconds?: number;
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
  private readonly access: ProjectAccessService;
  private readonly now: () => Date;
  private readonly createClientId: () => string;
  private readonly createSecret: () => string;
  private readonly createSecretId: () => string;
  private readonly digestSecret: (secret: string) => Promise<string>;
  private readonly maxClientsPerProject: number;
  private readonly maxPendingClientsPerProject: number;
  private readonly adminQuotaExempt: boolean;
  private readonly defaultSecretGraceSeconds: number;
  private readonly maxSecretGraceSeconds: number;
  private readonly minimumSecretRotationIntervalSeconds: number;

  constructor(
    private readonly repository: OidcClientRepository,
    projectAccess: ProjectAccessService,
    private readonly appEnv: string,
    dependencies: ServiceDependencies = {},
  ) {
    this.access = projectAccess;
    this.now = dependencies.now ?? (() => new Date());
    this.createClientId =
      dependencies.createClientId ?? (() => randomId("client", 18));
    this.createSecret =
      dependencies.createSecret ?? (() => base64Url(randomBytes(32)));
    this.createSecretId =
      dependencies.createSecretId ?? (() => randomId("secret", 18));
    this.digestSecret = dependencies.digestSecret ?? createClientSecretDigest;
    this.maxClientsPerProject = dependencies.maxClientsPerProject ?? 10;
    this.maxPendingClientsPerProject =
      dependencies.maxPendingClientsPerProject ?? 5;
    this.adminQuotaExempt = dependencies.adminQuotaExempt ?? true;
    this.defaultSecretGraceSeconds =
      dependencies.defaultSecretGraceSeconds ?? 86_400;
    this.maxSecretGraceSeconds = dependencies.maxSecretGraceSeconds ?? 604_800;
    this.minimumSecretRotationIntervalSeconds =
      dependencies.minimumSecretRotationIntervalSeconds ?? 0;
  }

  async list(actor: ClientActor, projectId: string) {
    await this.access.require(actor, projectId, "view");
    const clients = await this.repository.listOidcClientsByProject(projectId);
    return clients.map(toPublicClient);
  }

  async listPending(actor: ClientActor) {
    this.requireAdmin(actor);
    return (await this.repository.listPendingOidcClients()).map(toPublicClient);
  }

  async get(actor: ClientActor, projectId: string, clientId: string) {
    return toPublicClient(
      await this.requireAccessible(actor, projectId, clientId, "view"),
    );
  }

  async create(actor: ClientActor, projectId: string, raw: unknown) {
    await this.access.require(actor, projectId, "write_client");
    this.assertAllowedKeys(raw, createFields);
    const configuration = this.validate(raw);
    const clientId = this.createClientId();
    const secret =
      configuration.clientType === "web" ? this.createSecret() : undefined;
    const digest = secret ? await this.digestSecret(secret) : undefined;
    const timestamp = this.now().toISOString();
    const client: OidcClientRecord = {
      clientId,
      projectId,
      displayName: configuration.displayName,
      description: configuration.description,
      createdBySubjectId: actor.subjectId,
      clientType: configuration.clientType,
      autoConsent: false,
      lifecycleStatus: "draft",
      activeRevisionId: null,
      authorizationGeneration: 1,
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
    const secretRecord: OidcClientSecretRecord | undefined = digest
      ? {
          secretId: this.createSecretId(),
          clientId,
          secretDigest: digest,
          status: "active",
          createdAt: timestamp,
          expiresAt: null,
          revokedAt: null,
          version: 1,
        }
      : undefined;
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
    if (secretRecord)
      audits.push({
        ...this.audit(
          actor,
          clientId,
          "client.secret_generated",
          ["status", "createdAt"],
          timestamp,
        ),
        secretId: secretRecord.secretId,
      });
    const created = await this.repository.createOidcClient(
      client,
      revision,
      secretRecord,
      audits,
      actor.isAdmin && this.adminQuotaExempt
        ? undefined
        : {
            maxNonDisabledClients: this.maxClientsPerProject,
            maxPendingClients: this.maxPendingClientsPerProject,
          },
    );
    if (!created)
      throw new ClientManagementError(
        409,
        "client_quota_exceeded",
        "client quota exceeded for this project",
      );
    return {
      client: toPublicClient(created),
      ...(secret ? { clientSecret: secret } : {}),
    };
  }

  async update(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    raw: unknown,
  ) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, [
      "clientVersion",
      "displayName",
      "description",
    ]);
    const current = await this.requireAccessible(
      actor,
      projectId,
      clientId,
      "write_client",
    );
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

  async saveRevision(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    raw: unknown,
  ) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, [
      "revisionId",
      "revisionVersion",
      ...configurationFields,
    ]);
    const current = await this.requireAccessible(
      actor,
      projectId,
      clientId,
      "write_client",
    );
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
        ? this.maxPendingClientsPerProject
        : undefined,
    );
    return toPublicClient(this.requireRevisionUpdated(updated));
  }

  async submit(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    raw: unknown,
  ) {
    return this.transitionOwned(
      actor,
      projectId,
      clientId,
      raw,
      "draft",
      "pending",
      "revision.submitted",
    );
  }

  async withdraw(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    raw: unknown,
  ) {
    return this.transitionOwned(
      actor,
      projectId,
      clientId,
      raw,
      "pending",
      "draft",
      "revision.withdrawn",
    );
  }

  async rotateSecret(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    raw: unknown,
  ) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["clientVersion", "gracePeriodSeconds"]);
    const current = await this.requireAccessible(
      actor,
      projectId,
      clientId,
      "rotate_secret",
    );
    this.requireEnabled(current);
    if (current.client.clientType !== "web") {
      throw new ClientManagementError(
        409,
        "invalid_client_type",
        "only web clients have client secrets",
      );
    }
    const clientVersion = this.parseVersion(
      body["clientVersion"],
      "clientVersion",
    );
    const gracePeriodSeconds = this.parseGracePeriod(
      body["gracePeriodSeconds"],
    );
    if (current.client.version !== clientVersion) {
      throw new ClientManagementError(
        409,
        "version_conflict",
        "client changed concurrently",
      );
    }
    const preflightNow = this.now().getTime();
    const usableSecrets = current.secrets.filter(
      (secret) =>
        secret.status === "active" ||
        (secret.status === "retiring" &&
          secret.expiresAt !== null &&
          new Date(secret.expiresAt).getTime() > preflightNow),
    );
    if (usableSecrets.length >= 2) {
      throw new ClientManagementError(
        409,
        "secret_limit_exceeded",
        "client already has two usable secrets",
      );
    }
    const newestSecret = current.secrets[0];
    if (newestSecret && this.minimumSecretRotationIntervalSeconds > 0) {
      const retryAfterSeconds = Math.ceil(
        (new Date(newestSecret.createdAt).getTime() +
          this.minimumSecretRotationIntervalSeconds * 1000 -
          preflightNow) /
          1000,
      );
      if (retryAfterSeconds > 0) {
        throw new ClientManagementError(
          429,
          "rate_limited",
          `secret rotation cooldown active; retry after ${retryAfterSeconds} seconds`,
          undefined,
          retryAfterSeconds,
        );
      }
    }
    const value = this.createSecret();
    const timestamp = this.now().toISOString();
    const secret: OidcClientSecretRecord = {
      secretId: this.createSecretId(),
      clientId,
      secretDigest: await this.digestSecret(value),
      status: "active",
      createdAt: timestamp,
      expiresAt: null,
      revokedAt: null,
      version: 1,
    };
    const result = await this.repository.rotateOidcClientSecret(
      clientId,
      secret,
      clientVersion,
      gracePeriodSeconds,
      this.minimumSecretRotationIntervalSeconds,
      {
        ...this.audit(
          actor,
          clientId,
          "client.secret_rotated",
          ["status", "expiresAt"],
          timestamp,
        ),
        secretId: secret.secretId,
        reason: `grace_period_seconds=${gracePeriodSeconds}`,
      },
    );
    const updated = this.requireSecurityUpdated(result);
    const persistedSecret =
      result.status === "updated" && result.secret ? result.secret : secret;
    return {
      client: toPublicClient(updated),
      secret: {
        ...toPublicSecret(persistedSecret),
        value,
      },
    };
  }

  async revokeSecret(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    secretId: string,
    raw: unknown,
  ) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["clientVersion", "secretVersion"]);
    const current = await this.requireAccessible(
      actor,
      projectId,
      clientId,
      "revoke_secret",
    );
    this.requireEnabled(current);
    const timestamp = this.now().toISOString();
    const result = await this.repository.revokeOidcClientSecret(
      clientId,
      secretId,
      this.parseVersion(body["clientVersion"], "clientVersion"),
      this.parseVersion(body["secretVersion"], "secretVersion"),
      timestamp,
      {
        ...this.audit(
          actor,
          clientId,
          "client.secret_revoked",
          ["status", "revokedAt"],
          timestamp,
        ),
        secretId,
      },
    );
    return toPublicClient(this.requireSecurityUpdated(result));
  }

  async revokeAuthorizations(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    raw: unknown,
  ) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["clientVersion"]);
    const current = await this.requireAccessible(
      actor,
      projectId,
      clientId,
      "revoke_authorizations",
    );
    this.requireEnabled(current);
    const timestamp = this.now().toISOString();
    const updated = await this.repository.revokeOidcClientAuthorizations(
      clientId,
      this.parseVersion(body["clientVersion"], "clientVersion"),
      timestamp,
      this.audit(
        actor,
        clientId,
        "client.authorizations_revoked",
        ["authorizations", "authorizationGeneration"],
        timestamp,
      ),
    );
    return toPublicClient(this.requireUpdated(updated));
  }

  async disable(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    raw: unknown,
  ) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["clientVersion"]);
    const current = await this.requireAccessible(
      actor,
      projectId,
      clientId,
      "disable_client",
    );
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
          "client.emergency_disabled",
          [
            "lifecycleStatus",
            "secrets",
            "authorizations",
            "authorizationGeneration",
          ],
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

  async approve(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    raw: unknown,
  ) {
    this.requireAdmin(actor);
    await this.access.require(actor, projectId, "review");
    await this.requireProjectClient(projectId, clientId);
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

  async reject(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    raw: unknown,
  ) {
    this.requireAdmin(actor);
    await this.access.require(actor, projectId, "review");
    await this.requireProjectClient(projectId, clientId);
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
    projectId: string,
    clientId: string,
    raw: unknown,
    from: ClientRevisionStatus,
    to: ClientRevisionStatus,
    action: OidcClientAuditRecord["action"],
  ) {
    const body = this.requireObject(raw);
    this.assertAllowedKeys(body, ["revisionId", "revisionVersion"]);
    const current = await this.requireAccessible(
      actor,
      projectId,
      clientId,
      "write_client",
    );
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
        ? this.maxPendingClientsPerProject
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

  private async requireAccessible(
    actor: ClientActor,
    projectId: string,
    clientId: string,
    action: ProjectAction,
  ) {
    await this.access.require(actor, projectId, action);
    const managed = await this.requireProjectClient(projectId, clientId);
    return managed;
  }

  private async requireProjectClient(projectId: string, clientId: string) {
    const managed = await this.requireExisting(clientId);
    if (managed.client.projectId !== projectId)
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

  private parseGracePeriod(value: unknown) {
    if (value === undefined) return this.defaultSecretGraceSeconds;
    if (
      !Number.isInteger(value) ||
      Number(value) < 0 ||
      Number(value) > this.maxSecretGraceSeconds
    ) {
      throw new ClientManagementError(
        400,
        "invalid_request",
        `gracePeriodSeconds must be an integer between 0 and ${this.maxSecretGraceSeconds}`,
        "gracePeriodSeconds",
      );
    }
    return Number(value);
  }

  private requireSecurityUpdated(
    result: Awaited<ReturnType<OidcClientRepository["rotateOidcClientSecret"]>>,
  ) {
    if (result.status === "secret_limit_exceeded") {
      throw new ClientManagementError(
        409,
        "secret_limit_exceeded",
        "client already has two usable secrets",
      );
    }
    if (result.status === "secret_not_found") {
      throw new ClientManagementError(404, "not_found", "secret not found");
    }
    if (result.status === "secret_rotation_cooldown") {
      throw new ClientManagementError(
        429,
        "rate_limited",
        `secret rotation cooldown active; retry after ${result.retryAfterSeconds} seconds`,
        undefined,
        result.retryAfterSeconds,
      );
    }
    if (result.status === "version_conflict") this.conflict();
    return result.client;
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
    projectId: client.projectId,
    displayName: client.displayName,
    description: client.description,
    createdBySubjectId: client.createdBySubjectId,
    clientType: client.clientType,
    lifecycleStatus: client.lifecycleStatus,
    activeRevision: toPublicRevision(managed.activeRevision),
    proposedRevision: toPublicRevision(managed.proposedRevision),
    secrets: managed.secrets.map(toPublicSecret),
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    clientVersion: client.version,
  };
}

function toPublicSecret(secret: OidcClientSecretRecord): PublicClientSecret {
  return {
    secretId: secret.secretId,
    status: secret.status,
    createdAt: secret.createdAt,
    expiresAt: secret.expiresAt,
    revokedAt: secret.revokedAt,
    version: secret.version,
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
