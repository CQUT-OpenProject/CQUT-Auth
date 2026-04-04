import type { Pool } from "pg";
import type { OidcArtifactRepository, PendingInteractionLogin } from "./contracts.js";

type ArtifactRecord = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  expiresAt: string | undefined;
  consumedAt: string | undefined;
  grantId: string | undefined;
  uid: string | undefined;
  userCode: string | undefined;
  clientId: string | undefined;
  subjectId: string | undefined;
  createdAt: string;
};

export class OidcArtifactRepositoryImpl implements OidcArtifactRepository {
  private readonly artifacts = new Map<string, ArtifactRecord>();

  constructor(
    private readonly poolProvider: () => Pool | undefined,
    private readonly interactionTtlSeconds: number
  ) {}

  async upsertArtifact(
    id: string,
    kind: string,
    payload: Record<string, unknown>,
    expiresIn: number
  ): Promise<void> {
    const pool = this.poolProvider();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const artifact: ArtifactRecord = {
      id,
      kind,
      payload,
      expiresAt,
      consumedAt: undefined,
      grantId: typeof payload["grantId"] === "string" ? payload["grantId"] : undefined,
      uid: typeof payload["uid"] === "string" ? payload["uid"] : undefined,
      userCode: typeof payload["userCode"] === "string" ? payload["userCode"] : undefined,
      clientId: typeof payload["clientId"] === "string" ? payload["clientId"] : undefined,
      subjectId:
        typeof payload["accountId"] === "string"
          ? payload["accountId"]
          : typeof payload["sub"] === "string"
            ? payload["sub"]
            : undefined,
      createdAt: now
    };
    if (!pool) {
      this.artifacts.set(id, artifact);
      return;
    }
    await pool.query(
      `
      insert into oidc_artifacts (
        id,
        kind,
        grant_id,
        uid,
        user_code,
        client_id,
        subject_id,
        payload,
        expires_at,
        consumed_at,
        created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz, $11::timestamptz)
      on conflict (id) do update
      set kind = excluded.kind,
          grant_id = excluded.grant_id,
          uid = excluded.uid,
          user_code = excluded.user_code,
          client_id = excluded.client_id,
          subject_id = excluded.subject_id,
          payload = excluded.payload,
          expires_at = excluded.expires_at,
          consumed_at = excluded.consumed_at
      `,
      [
        artifact.id,
        artifact.kind,
        artifact.grantId ?? null,
        artifact.uid ?? null,
        artifact.userCode ?? null,
        artifact.clientId ?? null,
        artifact.subjectId ?? null,
        JSON.stringify(payload),
        artifact.expiresAt ?? null,
        artifact.consumedAt ?? null,
        artifact.createdAt
      ]
    );
  }

  async findArtifact(id: string): Promise<Record<string, unknown> | undefined> {
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

  async findArtifactByUid(uid: string): Promise<Record<string, unknown> | undefined> {
    const record = await this.readArtifactByColumn("uid", uid);
    return record ? this.mapArtifactPayload(record) : undefined;
  }

  async findArtifactByUserCode(userCode: string): Promise<Record<string, unknown> | undefined> {
    const record = await this.readArtifactByColumn("user_code", userCode);
    return record ? this.mapArtifactPayload(record) : undefined;
  }

  async revokeArtifactsByGrantId(grantId: string): Promise<void> {
    const pool = this.poolProvider();
    if (!pool) {
      for (const [id, artifact] of this.artifacts.entries()) {
        if (artifact.grantId === grantId) {
          this.artifacts.delete(id);
        }
      }
      return;
    }
    await pool.query("delete from oidc_artifacts where grant_id = $1", [grantId]);
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
    return this.mapArtifactRow(result.rows[0]);
  }

  private async readArtifactByColumn(column: "uid" | "user_code", value: string): Promise<ArtifactRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const record = [...this.artifacts.values()].find(
        (candidate) => candidate[column === "uid" ? "uid" : "userCode"] === value
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
    const result = await pool.query(
      `
      select * from oidc_artifacts
      where ${column} = $1
        and (expires_at is null or expires_at > now())
      limit 1
      `,
      [value]
    );
    return this.mapArtifactRow(result.rows[0]);
  }

  private mapArtifactRow(row: Record<string, unknown> | undefined): ArtifactRecord | null {
    if (!row) {
      return null;
    }
    return {
      id: String(row["id"]),
      kind: String(row["kind"]),
      grantId: (row["grant_id"] as string | null) ?? undefined,
      uid: (row["uid"] as string | null) ?? undefined,
      userCode: (row["user_code"] as string | null) ?? undefined,
      clientId: (row["client_id"] as string | null) ?? undefined,
      subjectId: (row["subject_id"] as string | null) ?? undefined,
      payload: row["payload"] as Record<string, unknown>,
      expiresAt: row["expires_at"] ? (row["expires_at"] as Date).toISOString() : undefined,
      consumedAt: row["consumed_at"] ? (row["consumed_at"] as Date).toISOString() : undefined,
      createdAt: (row["created_at"] as Date).toISOString()
    };
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
}
