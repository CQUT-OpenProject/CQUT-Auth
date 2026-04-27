import type { Pool } from "pg";
import type { ArtifactPayloadCipherServiceImpl } from "./artifact-payload-cipher.service.js";
import type { OidcArtifactRepository, PendingInteractionLogin } from "./contracts.js";

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
  uidHash: string | undefined;
  userCodeHash: string | undefined;
  createdAt: string;
};

type OpportunisticCleanupOptions = {
  enabled: boolean;
  sampleRate: number;
  batchSize: number;
  minIntervalSeconds: number;
};

export class OidcArtifactRepositoryImpl implements OidcArtifactRepository {
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly logger = console;
  private cleanupInFlight: Promise<void> | undefined;
  private lastCleanupAt = 0;

  constructor(
    private readonly poolProvider: () => Pool | undefined,
    private readonly interactionTtlSeconds: number,
    private readonly cleanupOptions: OpportunisticCleanupOptions,
    private readonly artifactPayloadCipherService: ArtifactPayloadCipherServiceImpl
  ) {
    if (cleanupOptions.enabled) {
      this.logger.warn(
        "opportunistic oidc artifact cleanup is enabled; request paths may trigger extra database deletes"
      );
    }
  }

  async upsertArtifact(
    id: string,
    kind: string,
    payload: Record<string, unknown>,
    expiresIn: number
  ): Promise<void> {
    this.maybeCleanupExpiredArtifacts();
    const pool = this.poolProvider();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
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
      uidHash:
        typeof payload["uid"] === "string" ? this.computeLookupHash(payload["uid"]) : undefined,
      userCodeHash:
        typeof payload["userCode"] === "string"
          ? this.computeLookupHash(payload["userCode"])
          : undefined,
      createdAt: now
    };
    if (!pool) {
      this.artifacts.set(id, artifact);
      return;
    }
    const encryptedPayload = await this.encryptPayload(payload);
    await pool.query(
      `
      insert into oidc_artifacts (
        id,
        kind,
        grant_id_hash,
        uid_hash,
        user_code_hash,
        payload,
        expires_at,
        consumed_at,
        created_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz, $9::timestamptz)
      on conflict (id) do update
      set kind = excluded.kind,
          grant_id_hash = excluded.grant_id_hash,
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
        artifact.uidHash ?? null,
        artifact.userCodeHash ?? null,
        JSON.stringify(encryptedPayload),
        artifact.expiresAt ?? null,
        artifact.consumedAt ?? null,
        artifact.createdAt
      ]
    );
  }

  async findArtifact(id: string): Promise<Record<string, unknown> | undefined> {
    this.maybeCleanupExpiredArtifacts();
    const record = await this.readArtifactById(id);
    return record ? this.mapArtifactPayload(record) : undefined;
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
      if (record) {
        record.consumedAt = new Date().toISOString();
      }
      return;
    }
    await pool.query(
      "update oidc_artifacts set consumed_at = now() where id = $1 and consumed_at is null",
      [id]
    );
  }

  async findArtifactByUid(uid: string, kind?: string): Promise<Record<string, unknown> | undefined> {
    this.maybeCleanupExpiredArtifacts();
    const record = await this.readArtifactByColumn("uid_hash", this.computeLookupHash(uid), kind);
    return record ? this.mapArtifactPayload(record) : undefined;
  }

  async findArtifactByUserCode(userCode: string): Promise<Record<string, unknown> | undefined> {
    this.maybeCleanupExpiredArtifacts();
    const record = await this.readArtifactByColumn(
      "user_code_hash",
      this.computeLookupHash(userCode)
    );
    return record ? this.mapArtifactPayload(record) : undefined;
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
    await pool.query("delete from oidc_artifacts where grant_id_hash = $1", [grantIdHash]);
  }

  async saveInteractionLogin(uid: string, value: PendingInteractionLogin): Promise<void> {
    await this.upsertArtifact(
      `interaction_login:${uid}`,
      "InteractionLogin",
      value as unknown as Record<string, unknown>,
      this.interactionTtlSeconds
    );
  }

  async getInteractionLogin(uid: string): Promise<PendingInteractionLogin | undefined> {
    const payload = await this.findArtifact(`interaction_login:${uid}`);
    return payload as PendingInteractionLogin | undefined;
  }

  async deleteInteractionLogin(uid: string): Promise<void> {
    await this.destroyArtifact(`interaction_login:${uid}`);
  }

  private async readArtifactById(id: string): Promise<ArtifactRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const record = this.artifacts.get(id);
      if (!record) {
        return null;
      }
      if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
        this.artifacts.delete(id);
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
      [id]
    );
    return await this.mapArtifactRow(result.rows[0]);
  }

  private async readArtifactByColumn(
    column: "uid_hash" | "user_code_hash",
    value: string,
    kind?: string
  ): Promise<ArtifactRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const record = [...this.artifacts.values()].find(
        (candidate) =>
          candidate[column === "uid_hash" ? "uidHash" : "userCodeHash"] === value &&
          (kind === undefined || candidate.kind === kind)
      );
      if (!record) {
        return null;
      }
      if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
        this.artifacts.delete(record.id);
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
      values
    );
    return await this.mapArtifactRow(result.rows[0]);
  }

  private async mapArtifactRow(row: Record<string, unknown> | undefined): Promise<ArtifactRecord | null> {
    if (!row) {
      return null;
    }
    const id = String(row["id"]);
    let payload: Record<string, unknown>;
    try {
      payload = await this.decryptPayloadEnvelope(row["payload"]);
    } catch (error) {
      this.logger.warn(
        `oidc artifact payload decrypt failed for ${id}: ${error instanceof Error ? error.message : "unknown error"}`
      );
      return null;
    }
    return {
      id,
      kind: String(row["kind"]),
      grantIdHash: (row["grant_id_hash"] as string | null) ?? undefined,
      uidHash: (row["uid_hash"] as string | null) ?? undefined,
      userCodeHash: (row["user_code_hash"] as string | null) ?? undefined,
      payload,
      expiresAt: row["expires_at"] ? (row["expires_at"] as Date).toISOString() : undefined,
      consumedAt: row["consumed_at"] ? (row["consumed_at"] as Date).toISOString() : undefined,
      createdAt: (row["created_at"] as Date).toISOString()
    };
  }

  private computeLookupHash(value: string): string {
    return this.artifactPayloadCipherService.hashLookupValue(value);
  }

  private async encryptPayload(payload: Record<string, unknown>): Promise<EncryptedArtifactPayloadEnvelope> {
    return {
      version: 1,
      ciphertext: await this.artifactPayloadCipherService.encryptPayload(payload)
    };
  }

  private async decryptPayloadEnvelope(payload: unknown): Promise<Record<string, unknown>> {
    if (!this.isEncryptedPayloadEnvelope(payload)) {
      throw new Error("invalid payload envelope");
    }
    return await this.artifactPayloadCipherService.decryptPayload(payload.ciphertext);
  }

  private isEncryptedPayloadEnvelope(payload: unknown): payload is EncryptedArtifactPayloadEnvelope {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    const candidate = payload as Record<string, unknown>;
    return candidate["version"] === 1 && typeof candidate["ciphertext"] === "string";
  }

  private mapArtifactPayload(record: ArtifactRecord): Record<string, unknown> {
    return {
      ...record.payload,
      ...(record.consumedAt
        ? {
            consumed: Math.floor(new Date(record.consumedAt).getTime() / 1000)
          }
        : {})
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
    if (now - this.lastCleanupAt < this.cleanupOptions.minIntervalSeconds * 1000) {
      return;
    }
    this.lastCleanupAt = now;
    this.cleanupInFlight = pool
      .query(
        `
        with doomed as (
          select id
          from oidc_artifacts
          where expires_at is not null and expires_at <= now()
          order by expires_at asc
          limit $1
        )
        delete from oidc_artifacts as oa
        using doomed
        where oa.id = doomed.id
        `,
        [this.cleanupOptions.batchSize]
      )
      .then(() => undefined)
      .catch((error) => {
        this.logger.warn(
          `opportunistic oidc artifact cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      })
      .finally(() => {
        this.cleanupInFlight = undefined;
      });
  }
}
