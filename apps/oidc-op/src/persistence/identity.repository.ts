import type {
  AuthenticatedPrincipal,
  SubjectIdentityRecord,
  SubjectProfileRecord,
  SubjectRecord
} from "@cqut/identity-core";
import type { Pool } from "pg";
import type { IdentityRepository } from "./contracts.js";

export class IdentityRepositoryImpl implements IdentityRepository {
  private readonly subjects = new Map<string, SubjectRecord>();
  private readonly identities = new Map<string, SubjectIdentityRecord>();
  private readonly profiles = new Map<string, SubjectProfileRecord>();

  constructor(private readonly poolProvider: () => Pool | undefined) {}

  async findSubject(subjectId: string): Promise<SubjectRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.subjects.get(subjectId) ?? null;
    }
    const result = await pool.query("select * from subjects where subject_id = $1 limit 1", [subjectId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      subjectId: row.subject_id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  }

  async findIdentity(provider: string, identityKey: string): Promise<SubjectIdentityRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.identities.get(this.identityMapKey(provider, identityKey)) ?? null;
    }
    const result = await pool.query(
      `
      select * from subject_identities
      where provider = $1 and identity_key = $2
      limit 1
      `,
      [provider, identityKey]
    );
    return this.mapIdentityRow(result.rows[0]);
  }

  async createSubjectWithIdentity(
    subject: SubjectRecord,
    identity: SubjectIdentityRecord
  ): Promise<SubjectIdentityRecord> {
    const pool = this.poolProvider();
    if (!pool) {
      this.subjects.set(subject.subjectId, subject);
      this.identities.set(this.identityMapKey(identity.provider, identity.identityKey), identity);
      return identity;
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
        insert into subjects (subject_id, status, created_at, updated_at)
        values ($1, $2, $3::timestamptz, $4::timestamptz)
        `,
        [subject.subjectId, subject.status, subject.createdAt, subject.updatedAt]
      );
      const identityResult = await client.query(
        `
        insert into subject_identities (
          subject_id,
          provider,
          school_uid,
          identity_key,
          current_student_status,
          school,
          created_at,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
        returning *
        `,
        [
          identity.subjectId,
          identity.provider,
          identity.schoolUid,
          identity.identityKey,
          identity.currentStudentStatus,
          identity.school,
          identity.createdAt,
          identity.updatedAt
        ]
      );
      await client.query("commit");
      return this.mapIdentityRow(identityResult.rows[0]) as SubjectIdentityRecord;
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string }).code === "23505") {
        const existing = await this.findIdentity(identity.provider, identity.identityKey);
        if (existing) {
          return existing;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateIdentity(
    provider: string,
    identityKey: string,
    patch: Pick<SubjectIdentityRecord, "schoolUid" | "currentStudentStatus" | "school" | "updatedAt">
  ): Promise<SubjectIdentityRecord> {
    const pool = this.poolProvider();
    if (!pool) {
      const existing = this.identities.get(this.identityMapKey(provider, identityKey));
      if (!existing) {
        throw new Error(`identity not found: ${provider}/${identityKey}`);
      }
      const next = {
        ...existing,
        schoolUid: patch.schoolUid,
        currentStudentStatus: patch.currentStudentStatus,
        school: patch.school,
        updatedAt: patch.updatedAt
      };
      this.identities.set(this.identityMapKey(provider, identityKey), next);
      return next;
    }
    const result = await pool.query(
      `
      update subject_identities
      set school_uid = $3,
          current_student_status = $4,
          school = $5,
          updated_at = $6::timestamptz
      where provider = $1 and identity_key = $2
      returning *
      `,
      [provider, identityKey, patch.schoolUid, patch.currentStudentStatus, patch.school, patch.updatedAt]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`identity not found: ${provider}/${identityKey}`);
    }
    return this.mapIdentityRow(row) as SubjectIdentityRecord;
  }

  async getProfile(subjectId: string): Promise<SubjectProfileRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.profiles.get(subjectId) ?? null;
    }
    const result = await pool.query("select * from subject_profiles where subject_id = $1 limit 1", [subjectId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      subjectId: row.subject_id,
      preferredUsername: row.preferred_username ?? undefined,
      displayName: row.display_name ?? undefined,
      email: row.email ?? undefined,
      emailVerified: row.email_verified,
      updatedAt: row.updated_at.toISOString()
    };
  }

  async upsertProfile(profile: SubjectProfileRecord): Promise<SubjectProfileRecord> {
    const pool = this.poolProvider();
    if (!pool) {
      this.profiles.set(profile.subjectId, profile);
      return profile;
    }
    const result = await pool.query(
      `
      insert into subject_profiles (
        subject_id,
        preferred_username,
        display_name,
        email,
        email_verified,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::timestamptz)
      on conflict (subject_id) do update
      set preferred_username = excluded.preferred_username,
          display_name = excluded.display_name,
          email = excluded.email,
          email_verified = excluded.email_verified,
          updated_at = excluded.updated_at
      returning *
      `,
      [
        profile.subjectId,
        profile.preferredUsername ?? null,
        profile.displayName ?? null,
        profile.email ?? null,
        profile.emailVerified,
        profile.updatedAt
      ]
    );
    const row = result.rows[0];
    return {
      subjectId: row.subject_id,
      preferredUsername: row.preferred_username ?? undefined,
      displayName: row.display_name ?? undefined,
      email: row.email ?? undefined,
      emailVerified: row.email_verified,
      updatedAt: row.updated_at.toISOString()
    };
  }

  async findPrincipalBySubjectId(subjectId: string): Promise<AuthenticatedPrincipal | null> {
    const pool = this.poolProvider();
    if (!pool) {
      const subject = this.subjects.get(subjectId);
      if (!subject || subject.status !== "active") {
        return null;
      }
      const identity = [...this.identities.values()]
        .filter((candidate) => candidate.subjectId === subjectId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (!identity) {
        return null;
      }
      const profile = this.profiles.get(subjectId);
      return {
        subjectId,
        schoolUid: identity.schoolUid,
        school: identity.school,
        studentStatus: identity.currentStudentStatus,
        identitySource: identity.provider,
        identityKey: identity.identityKey,
        email: profile?.email,
        emailVerified: profile?.emailVerified ?? false,
        displayName: profile?.displayName,
        preferredUsername: profile?.preferredUsername ?? identity.schoolUid
      };
    }
    const result = await pool.query(
      `
      select
        s.subject_id,
        s.status,
        si.provider,
        si.school_uid,
        si.identity_key,
        si.current_student_status,
        si.school,
        sp.preferred_username,
        sp.display_name,
        sp.email,
        sp.email_verified
      from subjects s
      join lateral (
        select *
        from subject_identities
        where subject_id = s.subject_id
        order by updated_at desc
        limit 1
      ) si on true
      left join subject_profiles sp on sp.subject_id = s.subject_id
      where s.subject_id = $1
      limit 1
      `,
      [subjectId]
    );
    const row = result.rows[0];
    if (!row || row.status !== "active") {
      return null;
    }
    return {
      subjectId: row.subject_id,
      schoolUid: row.school_uid,
      school: row.school,
      studentStatus: row.current_student_status,
      identitySource: row.provider,
      identityKey: row.identity_key,
      email: row.email ?? undefined,
      emailVerified: row.email_verified ?? false,
      displayName: row.display_name ?? undefined,
      preferredUsername: row.preferred_username ?? row.school_uid
    };
  }

  private identityMapKey(provider: string, identityKey: string) {
    return `${provider}:${identityKey}`;
  }

  private mapIdentityRow(row: Record<string, unknown> | undefined): SubjectIdentityRecord | null {
    if (!row) {
      return null;
    }
    return {
      subjectId: String(row["subject_id"]),
      provider: String(row["provider"]),
      schoolUid: String(row["school_uid"]),
      identityKey: String(row["identity_key"]),
      currentStudentStatus: row["current_student_status"] as SubjectIdentityRecord["currentStudentStatus"],
      school: String(row["school"]),
      createdAt: (row["created_at"] as Date).toISOString(),
      updatedAt: (row["updated_at"] as Date).toISOString()
    };
  }
}
