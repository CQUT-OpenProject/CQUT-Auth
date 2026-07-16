import type { Pool, PoolClient } from "pg";
import type { ArtifactPayloadCipherServiceImpl } from "./artifact-payload-cipher.service.js";
import type {
  InteractionEmailVerificationResult,
  OidcArtifactRepository,
  PendingInteractionLogin,
} from "./contracts.js";
import { buildArtifactCleanupSql } from "./contracts.js";

type EncryptedArtifactPayloadEnvelope = {
  version: 1;
  ciphertext: string;
};

type ArtifactRecord = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  expiresAt: string | undefined;
  consumedAt: string | undefined;
  grantIdHash: string | undefined;
  clientIdHash: string | undefined;
  authorizationGeneration: number | undefined;
  uidHash: string | undefined;
  userCodeHash: string | undefined;
  createdAt: string;
};

type ClientAuthorizationState = {
  lifecycleStatus: "draft" | "active" | "disabled";
  authorizationGeneration: number;
};

const revocableKinds = new Set([
  "AuthorizationCode",
  "AccessToken",
  "RefreshToken",
  "Grant",
]);
const internalGenerationKey = "__cqutAuthorizationGeneration";
const internalClientIdKey = "__cqutAuthorizationClientId";

type OpportunisticCleanupOptions = {
  enabled: boolean;
  sampleRate: number;
  batchSize: number;
  minIntervalSeconds: number;
};

export class ArtifactAlreadyConsumedError extends Error {
  readonly status = 400;
  readonly statusCode = 400;
  readonly expose = true;
  readonly error_description = "grant request is invalid";

  constructor() {
    super("invalid_grant");
    this.name = "ArtifactAlreadyConsumedError";
  }
}

export class OidcArtifactRepositoryImpl implements OidcArtifactRepository {
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly logger = console;
  private cleanupInFlight: Promise<void> | undefined;
  private lastCleanupAt = 0;

  constructor(
    private readonly poolProvider: () => Pool | undefined,
    private readonly interactionTtlSeconds: number,
    private readonly cleanupOptions: OpportunisticCleanupOptions,
    private readonly artifactPayloadCipherService: ArtifactPayloadCipherServiceImpl,
    private readonly findMemoryClientAuthorizationState: (
      clientId: string,
    ) => Promise<ClientAuthorizationState | null> = async () => ({
      lifecycleStatus: "active",
      authorizationGeneration: 1,
    }),
  ) {
    if (cleanupOptions.enabled) {
      this.logger.warn(
        "opportunistic oidc artifact cleanup is enabled; request paths may trigger extra database deletes",
      );
    }
  }

  async upsertArtifact(
    id: string,
    kind: string,
    payload: Record<string, unknown>,
    expiresIn: number,
    authorizationGeneration?: number,
  ): Promise<void> {
    this.maybeCleanupExpiredArtifacts();
    const pool = this.poolProvider();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const clientId =
      typeof payload["clientId"] === "string" ? payload["clientId"] : undefined;
    let resolvedGeneration = authorizationGeneration;
    let connection: PoolClient | undefined;
    if (clientId) {
      if (pool && typeof pool.connect === "function") {
        connection = await pool.connect();
        try {
          await connection.query("begin");
          const state = await connection.query(
            `select lifecycle_status, authorization_generation
             from oidc_clients where client_id = $1 for share`,
            [clientId],
          );
          if (
            !state.rows[0] ||
            state.rows[0]["lifecycle_status"] === "disabled"
          ) {
            await connection.query("rollback");
            connection.release();
            return;
          }
          resolvedGeneration ??= Number(
            state.rows[0]["authorization_generation"],
          );
        } catch (error) {
          await connection.query("rollback").catch(() => undefined);
          connection.release();
          throw error;
        }
      } else if (!pool) {
        const state = await this.findMemoryClientAuthorizationState(clientId);
        if (!state || state.lifecycleStatus === "disabled") return;
        resolvedGeneration ??= state.authorizationGeneration;
      } else {
        resolvedGeneration ??= 1;
      }
    }
    const artifact: ArtifactRecord = {
      id,
      kind,
      payload,
      expiresAt,
      consumedAt: undefined,
      grantIdHash:
        typeof payload["grantId"] === "string"
          ? this.computeLookupHash(payload["grantId"])
          : undefined,
      clientIdHash: clientId ? this.computeLookupHash(clientId) : undefined,
      authorizationGeneration: resolvedGeneration,
      uidHash:
        typeof payload["uid"] === "string"
          ? this.computeLookupHash(payload["uid"])
          : undefined,
      userCodeHash:
        typeof payload["userCode"] === "string"
          ? this.computeLookupHash(payload["userCode"])
          : undefined,
      createdAt: now,
    };
    if (!pool) {
      this.artifacts.set(id, artifact);
      return;
    }
    try {
      const encryptedPayload = await this.encryptPayload(payload);
      await (connection ?? pool).query(
        `
      insert into oidc_artifacts (
        id,
        kind,
        grant_id_hash,
        client_id_hash,
        authorization_generation,
        uid_hash,
        user_code_hash,
        payload,
        expires_at,
        consumed_at,
        created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz, $11::timestamptz)
      on conflict (id) do update
      set kind = excluded.kind,
          grant_id_hash = excluded.grant_id_hash,
          client_id_hash = excluded.client_id_hash,
          authorization_generation = excluded.authorization_generation,
          uid_hash = excluded.uid_hash,
          user_code_hash = excluded.user_code_hash,
          payload = excluded.payload,
          expires_at = excluded.expires_at,
          consumed_at = excluded.consumed_at
      `,
        [
          artifact.id,
          artifact.kind,
          artifact.grantIdHash ?? null,
          artifact.clientIdHash ?? null,
          artifact.authorizationGeneration ?? null,
          artifact.uidHash ?? null,
          artifact.userCodeHash ?? null,
          JSON.stringify(encryptedPayload),
          artifact.expiresAt ?? null,
          artifact.consumedAt ?? null,
          artifact.createdAt,
        ],
      );
      if (connection) await connection.query("commit");
    } catch (error) {
      if (connection) await connection.query("rollback");
      throw error;
    } finally {
      connection?.release();
    }
  }

  async findArtifact(id: string): Promise<Record<string, unknown> | undefined> {
    this.maybeCleanupExpiredArtifacts();
    const record = await this.readArtifactById(id);
    return record ? await this.mapArtifactPayload(record) : undefined;
  }

  async destroyArtifact(id: string): Promise<void> {
    const pool = this.poolProvider();
    if (!pool) {
      this.artifacts.delete(id);
      return;
    }
    await pool.query("delete from oidc_artifacts where id = $1", [id]);
  }

  async consumeArtifact(id: string): Promise<void> {
    const pool = this.poolProvider();
    if (!pool) {
      const record = this.artifacts.get(id);
      if (!record || record.consumedAt)
        throw new ArtifactAlreadyConsumedError();
      record.consumedAt = new Date().toISOString();
      return;
    }
    const result = await pool.query(
      "update oidc_artifacts set consumed_at = now() where id = $1 and consumed_at is null",
      [id],
    );
    if (result.rowCount !== 1) throw new ArtifactAlreadyConsumedError();
  }

  async findArtifactByUid(
    uid: string,
    kind?: string,
  ): Promise<Record<string, unknown> | undefined> {
    this.maybeCleanupExpiredArtifacts();
    const record = await this.readArtifactByColumn(
      "uid_hash",
      this.computeLookupHash(uid),
      kind,
    );
    return record ? await this.mapArtifactPayload(record) : undefined;
  }

  async findArtifactByUserCode(
    userCode: string,
  ): Promise<Record<string, unknown> | undefined> {
    this.maybeCleanupExpiredArtifacts();
    const record = await this.readArtifactByColumn(
      "user_code_hash",
      this.computeLookupHash(userCode),
    );
    return record ? await this.mapArtifactPayload(record) : undefined;
  }

  async revokeArtifactsByGrantId(grantId: string): Promise<void> {
    const pool = this.poolProvider();
    const grantIdHash = this.computeLookupHash(grantId);
    if (!pool) {
      for (const [id, artifact] of this.artifacts.entries()) {
        if (artifact.grantIdHash === grantIdHash) {
          this.artifacts.delete(id);
        }
      }
      return;
    }
    await pool.query("delete from oidc_artifacts where grant_id_hash = $1", [
      grantIdHash,
    ]);
  }

  async revokeArtifactsByClientId(clientId: string): Promise<void> {
    const pool = this.poolProvider();
    const clientIdHash = this.computeLookupHash(clientId);
    if (!pool) {
      for (const [id, artifact] of this.artifacts.entries()) {
        if (
          artifact.clientIdHash === clientIdHash &&
          revocableKinds.has(artifact.kind)
        ) {
          this.artifacts.delete(id);
        }
      }
      return;
    }
    await pool.query(
      `delete from oidc_artifacts
       where client_id_hash = $1
         and kind = any($2::text[])`,
      [clientIdHash, [...revocableKinds]],
    );
  }

  async saveInteractionLogin(
    uid: string,
    value: PendingInteractionLogin,
  ): Promise<void> {
    await this.upsertArtifact(
      `interaction_login:${uid}`,
      "InteractionLogin",
      value as unknown as Record<string, unknown>,
      this.interactionTtlSeconds,
    );
  }

  async getInteractionLogin(
    uid: string,
  ): Promise<PendingInteractionLogin | undefined> {
    const payload = await this.findArtifact(`interaction_login:${uid}`);
    return payload as PendingInteractionLogin | undefined;
  }

  async verifyInteractionEmailCode(
    uid: string,
    expectedCodeHash: string,
    inputCodeHash: string,
    now: number,
    maxAttempts: number,
  ): Promise<InteractionEmailVerificationResult> {
    const id = `interaction_login:${uid}`;
    const pool = this.poolProvider();
    if (!pool) {
      const record = this.artifacts.get(id);
      if (!record || this.isExpired(record)) return { status: "missing" };
      return this.applyEmailVerificationAttempt(
        record,
        expectedCodeHash,
        inputCodeHash,
        now,
        maxAttempts,
      );
    }

    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const selected = await connection.query(
        `select * from oidc_artifacts
         where id = $1
           and (expires_at is null or expires_at > now())
         for update`,
        [id],
      );
      const record = await this.mapArtifactRow(selected.rows[0]);
      if (!record) {
        await connection.query("commit");
        return { status: "missing" };
      }
      const result = this.applyEmailVerificationAttempt(
        record,
        expectedCodeHash,
        inputCodeHash,
        now,
        maxAttempts,
      );
      if (result.status !== "stale" && result.status !== "missing") {
        await connection.query(
          "update oidc_artifacts set payload = $2::jsonb where id = $1",
          [id, JSON.stringify(await this.encryptPayload(record.payload))],
        );
      }
      await connection.query("commit");
      return result;
    } catch (error) {
      await connection.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteInteractionLogin(uid: string): Promise<void> {
    await this.destroyArtifact(`interaction_login:${uid}`);
  }

  private isExpired(record: ArtifactRecord): boolean {
    if (
      record.expiresAt &&
      new Date(record.expiresAt).getTime() <= Date.now()
    ) {
      this.artifacts.delete(record.id);
      return true;
    }
    return false;
  }

  private applyEmailVerificationAttempt(
    record: ArtifactRecord,
    expectedCodeHash: string,
    inputCodeHash: string,
    now: number,
    maxAttempts: number,
  ): InteractionEmailVerificationResult {
    const pending = record.payload as unknown as PendingInteractionLogin;
    const verification = pending.emailVerification;
    if (!verification) return { status: "missing" };
    if (verification.codeHash !== expectedCodeHash) return { status: "stale" };

    if (verification.expiresAt <= now) {
      delete pending.emailVerification;
      return { status: "expired", email: verification.email };
    }
    if (verification.attempts >= maxAttempts) {
      delete pending.emailVerification;
      return { status: "locked", email: verification.email };
    }
    if (verification.codeHash === inputCodeHash) {
      delete pending.emailVerification;
      return { status: "verified", email: verification.email, pending };
    }

    verification.attempts += 1;
    const attemptsRemaining = maxAttempts - verification.attempts;
    if (attemptsRemaining === 0) {
      delete pending.emailVerification;
      return { status: "locked", email: verification.email };
    }
    return {
      status: "incorrect",
      email: verification.email,
      nextResendAt: verification.nextResendAt,
      attemptsRemaining,
    };
  }

  private async readArtifactById(id: string): Promise<ArtifactRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const record = this.artifacts.get(id);
      if (!record) {
        return null;
      }
      if (this.isExpired(record)) {
        return null;
      }
      return record;
    }
    const result = await pool.query(
      `
      select * from oidc_artifacts
      where id = $1
        and (expires_at is null or expires_at > now())
      limit 1
      `,
      [id],
    );
    return await this.mapArtifactRow(result.rows[0]);
  }

  private async readArtifactByColumn(
    column: "uid_hash" | "user_code_hash",
    value: string,
    kind?: string,
  ): Promise<ArtifactRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const record = [...this.artifacts.values()].find(
        (candidate) =>
          candidate[column === "uid_hash" ? "uidHash" : "userCodeHash"] ===
            value &&
          (kind === undefined || candidate.kind === kind),
      );
      if (!record) {
        return null;
      }
      if (this.isExpired(record)) {
        return null;
      }
      return record;
    }
    const values = kind === undefined ? [value] : [value, kind];
    const kindFilter = kind === undefined ? "" : "and kind = $2";
    const result = await pool.query(
      `
      select * from oidc_artifacts
      where ${column} = $1
        ${kindFilter}
        and (expires_at is null or expires_at > now())
      limit 1
      `,
      values,
    );
    return await this.mapArtifactRow(result.rows[0]);
  }

  private async mapArtifactRow(
    row: Record<string, unknown> | undefined,
  ): Promise<ArtifactRecord | null> {
    if (!row) {
      return null;
    }
    const id = String(row["id"]);
    let payload: Record<string, unknown>;
    try {
      payload = await this.decryptPayloadEnvelope(row["payload"]);
    } catch (error) {
      this.logger.warn(
        `oidc artifact payload decrypt failed for ${id}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
    return {
      id,
      kind: String(row["kind"]),
      grantIdHash: (row["grant_id_hash"] as string | null) ?? undefined,
      clientIdHash: (row["client_id_hash"] as string | null) ?? undefined,
      authorizationGeneration:
        row["authorization_generation"] == null
          ? undefined
          : Number(row["authorization_generation"]),
      uidHash: (row["uid_hash"] as string | null) ?? undefined,
      userCodeHash: (row["user_code_hash"] as string | null) ?? undefined,
      payload,
      expiresAt: row["expires_at"]
        ? (row["expires_at"] as Date).toISOString()
        : undefined,
      consumedAt: row["consumed_at"]
        ? (row["consumed_at"] as Date).toISOString()
        : undefined,
      createdAt: (row["created_at"] as Date).toISOString(),
    };
  }

  private computeLookupHash(value: string): string {
    return this.artifactPayloadCipherService.hashLookupValue(value);
  }

  private async encryptPayload(
    payload: Record<string, unknown>,
  ): Promise<EncryptedArtifactPayloadEnvelope> {
    return {
      version: 1,
      ciphertext:
        await this.artifactPayloadCipherService.encryptPayload(payload),
    };
  }

  private async decryptPayloadEnvelope(
    payload: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.isEncryptedPayloadEnvelope(payload)) {
      throw new Error("invalid payload envelope");
    }
    return await this.artifactPayloadCipherService.decryptPayload(
      payload.ciphertext,
    );
  }

  private isEncryptedPayloadEnvelope(
    payload: unknown,
  ): payload is EncryptedArtifactPayloadEnvelope {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    const candidate = payload as Record<string, unknown>;
    return (
      candidate["version"] === 1 && typeof candidate["ciphertext"] === "string"
    );
  }

  private async mapArtifactPayload(
    record: ArtifactRecord,
  ): Promise<Record<string, unknown> | undefined> {
    const clientId =
      typeof record.payload["clientId"] === "string"
        ? record.payload["clientId"]
        : undefined;
    if (
      clientId &&
      record.authorizationGeneration !== undefined &&
      revocableKinds.has(record.kind)
    ) {
      const state = await this.findClientAuthorizationState(clientId);
      if (
        !state ||
        state.lifecycleStatus === "disabled" ||
        state.authorizationGeneration !== record.authorizationGeneration
      ) {
        return undefined;
      }
    }
    return {
      ...record.payload,
      ...(clientId && record.authorizationGeneration !== undefined
        ? {
            [internalClientIdKey]: clientId,
            [internalGenerationKey]: record.authorizationGeneration,
          }
        : {}),
      ...(record.consumedAt
        ? {
            consumed: Math.floor(new Date(record.consumedAt).getTime() / 1000),
          }
        : {}),
    };
  }

  private async findClientAuthorizationState(
    clientId: string,
  ): Promise<ClientAuthorizationState | null> {
    const pool = this.poolProvider();
    if (!pool) return this.findMemoryClientAuthorizationState(clientId);
    const result = await pool.query(
      `select lifecycle_status, authorization_generation
       from oidc_clients where client_id = $1`,
      [clientId],
    );
    if (!result.rows[0]) return null;
    return {
      lifecycleStatus: result.rows[0]["lifecycle_status"],
      authorizationGeneration: Number(
        result.rows[0]["authorization_generation"],
      ),
    };
  }

  private maybeCleanupExpiredArtifacts() {
    const pool = this.poolProvider();
    if (!pool || !this.cleanupOptions.enabled) {
      return;
    }
    if (this.cleanupInFlight) {
      return;
    }
    if (Math.random() > this.cleanupOptions.sampleRate) {
      return;
    }
    const now = Date.now();
    if (
      now - this.lastCleanupAt <
      this.cleanupOptions.minIntervalSeconds * 1000
    ) {
      return;
    }
    this.lastCleanupAt = now;
    this.cleanupInFlight = pool
      .query(buildArtifactCleanupSql("$1"), [this.cleanupOptions.batchSize])
      .then(() => undefined)
      .catch((error) => {
        this.logger.warn(
          `opportunistic oidc artifact cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      })
      .finally(() => {
        this.cleanupInFlight = undefined;
      });
  }
}
