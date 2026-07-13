import type { Pool } from "pg";
import type {
  ManagementSessionRecord,
  ManagementSessionRepository,
} from "./contracts.js";

export class ManagementSessionRepositoryImpl implements ManagementSessionRepository {
  private readonly sessions = new Map<string, ManagementSessionRecord>();

  constructor(private readonly poolProvider: () => Pool | undefined) {}

  async createManagementSession(
    session: ManagementSessionRecord,
  ): Promise<void> {
    const pool = this.poolProvider();
    if (!pool) {
      this.sessions.set(session.tokenHash, session);
      return;
    }
    await pool.query(
      `insert into management_sessions (
        token_hash, subject_id, created_at, last_seen_at, expires_at
      ) values ($1, $2, $3::timestamptz, $4::timestamptz, $5::timestamptz)`,
      [
        session.tokenHash,
        session.subjectId,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
      ],
    );
  }

  async findManagementSession(
    tokenHash: string,
  ): Promise<ManagementSessionRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.sessions.get(tokenHash) ?? null;
    }
    const result = await pool.query(
      "select * from management_sessions where token_hash = $1 limit 1",
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      tokenHash: row.token_hash,
      subjectId: row.subject_id,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async touchManagementSession(
    tokenHash: string,
    lastSeenAt: string,
  ): Promise<void> {
    const pool = this.poolProvider();
    if (!pool) {
      const current = this.sessions.get(tokenHash);
      if (current) {
        this.sessions.set(tokenHash, { ...current, lastSeenAt });
      }
      return;
    }
    await pool.query(
      "update management_sessions set last_seen_at = $2::timestamptz where token_hash = $1",
      [tokenHash, lastSeenAt],
    );
  }

  async deleteManagementSession(tokenHash: string): Promise<void> {
    const pool = this.poolProvider();
    if (!pool) {
      this.sessions.delete(tokenHash);
      return;
    }
    await pool.query("delete from management_sessions where token_hash = $1", [
      tokenHash,
    ]);
  }

  async deleteExpiredManagementSessions(now: string): Promise<number> {
    const pool = this.poolProvider();
    if (!pool) {
      let deleted = 0;
      for (const [tokenHash, session] of this.sessions) {
        if (session.expiresAt <= now) {
          this.sessions.delete(tokenHash);
          deleted += 1;
        }
      }
      return deleted;
    }
    const result = await pool.query(
      "delete from management_sessions where expires_at <= $1::timestamptz",
      [now],
    );
    return result.rowCount ?? 0;
  }
}
