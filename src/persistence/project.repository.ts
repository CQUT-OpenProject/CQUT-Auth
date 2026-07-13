import type { Pool, PoolClient } from "pg";
import {
  SYSTEM_PROJECT_ID,
  type ProjectAuditRecord,
  type ProjectMemberRecord,
  type ProjectMutationResult,
  type ProjectRecord,
  type ProjectRepository,
  type ProjectRole,
} from "./contracts.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export class ProjectRepositoryImpl implements ProjectRepository {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly members = new Map<string, ProjectMemberRecord>();
  private readonly audits: ProjectAuditRecord[] = [];
  private readonly memoryLocks = new Map<string, Promise<void>>();
  private nextAuditId = 1;

  constructor(
    private readonly poolProvider: () => Pool | undefined,
    private readonly subjectExists: (subjectId: string) => Promise<boolean>,
  ) {}

  async ensureSystemProject() {
    const existing = await this.findProject(SYSTEM_PROJECT_ID);
    if (existing) return existing;
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      projectId: SYSTEM_PROJECT_ID,
      name: "System",
      description: "Bootstrap OIDC clients",
      status: "active",
      createdBySubjectId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const pool = this.poolProvider();
    if (!pool) {
      this.projects.set(project.projectId, project);
      this.pushAudit({
        projectId: project.projectId,
        actorSubjectId: null,
        action: "project.created",
        changedFields: ["name", "description", "status"],
        createdAt: now,
      });
      return project;
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const inserted = await connection.query(
        `insert into projects
         (project_id, name, description, status, created_by_subject_id, version, created_at, updated_at)
       values ($1, $2, $3, $4, null, 1, $5, $5)
       on conflict (project_id) do nothing returning project_id`,
        [
          project.projectId,
          project.name,
          project.description,
          project.status,
          now,
        ],
      );
      if (inserted.rowCount) {
        await this.insertAudit(connection, {
          projectId: project.projectId,
          actorSubjectId: null,
          action: "project.created",
          changedFields: ["name", "description", "status"],
          createdAt: now,
        });
      }
      await connection.query("commit");
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
    return (await this.findProject(project.projectId))!;
  }

  async createProject(
    project: ProjectRecord,
    owner: ProjectMemberRecord,
    audit: ProjectAuditRecord,
  ) {
    const pool = this.poolProvider();
    if (!pool) {
      this.projects.set(project.projectId, project);
      this.members.set(
        this.memberKey(project.projectId, owner.subjectId),
        owner,
      );
      this.pushAudit(audit);
      return project;
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      await connection.query(
        `insert into projects
           (project_id, name, description, status, created_by_subject_id, version, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          project.projectId,
          project.name,
          project.description,
          project.status,
          project.createdBySubjectId,
          project.version,
          project.createdAt,
          project.updatedAt,
        ],
      );
      await this.insertMember(connection, owner);
      await this.insertAudit(connection, audit);
      await connection.query("commit");
      return project;
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  async findProject(projectId: string) {
    const pool = this.poolProvider();
    if (!pool) return this.projects.get(projectId) ?? null;
    const result = await pool.query(
      "select * from projects where project_id = $1",
      [projectId],
    );
    return result.rowCount ? this.projectFromRow(result.rows[0]!) : null;
  }

  async findProjectRole(projectId: string, subjectId: string) {
    const pool = this.poolProvider();
    if (!pool)
      return (
        this.members.get(this.memberKey(projectId, subjectId))?.role ?? null
      );
    const result = await pool.query(
      "select role from project_members where project_id = $1 and subject_id = $2",
      [projectId, subjectId],
    );
    return (result.rows[0]?.["role"] as ProjectRole | undefined) ?? null;
  }

  async listProjectsForSubject(subjectId: string, includeAll: boolean) {
    const pool = this.poolProvider();
    if (!pool) {
      return [...this.projects.values()]
        .map((project) => ({
          project,
          role:
            this.members.get(this.memberKey(project.projectId, subjectId))
              ?.role ?? null,
        }))
        .filter(({ role }) => includeAll || role)
        .sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt));
    }
    const result = await pool.query(
      `select p.*, pm.role
       from projects p
       left join project_members pm
         on pm.project_id = p.project_id and pm.subject_id = $1
       where $2::boolean or pm.subject_id is not null
       order by p.updated_at desc`,
      [subjectId, includeAll],
    );
    return result.rows.map((row) => ({
      project: this.projectFromRow(row),
      role: (row["role"] as ProjectRole | null) ?? null,
    }));
  }

  async listProjectMembers(projectId: string) {
    const pool = this.poolProvider();
    if (!pool)
      return [...this.members.values()]
        .filter((member) => member.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const result = await pool.query(
      "select * from project_members where project_id = $1 order by created_at, subject_id",
      [projectId],
    );
    return result.rows.map((row) => this.memberFromRow(row));
  }

  async updateProject(
    projectId: string,
    expectedVersion: number,
    patch: Pick<ProjectRecord, "name" | "description" | "status" | "updatedAt">,
    audit: ProjectAuditRecord,
  ): Promise<ProjectMutationResult> {
    return this.mutateProject(
      projectId,
      expectedVersion,
      audit,
      async (queryable) => {
        if (!queryable) {
          const current = this.projects.get(projectId)!;
          this.projects.set(projectId, {
            ...current,
            ...patch,
            version: current.version + 1,
          });
          return "updated";
        }
        await queryable.query(
          `update projects set name = $2, description = $3, status = $4,
           updated_at = $5, version = version + 1 where project_id = $1`,
          [
            projectId,
            patch.name,
            patch.description,
            patch.status,
            patch.updatedAt,
          ],
        );
        return "updated";
      },
    );
  }

  async addProjectMember(
    member: ProjectMemberRecord,
    expectedVersion: number,
    audit: ProjectAuditRecord,
  ): Promise<ProjectMutationResult> {
    if (!(await this.subjectExists(member.subjectId)))
      return { status: "subject_not_found" };
    return this.mutateProject(
      member.projectId,
      expectedVersion,
      audit,
      async (queryable) => {
        if (!queryable) {
          const key = this.memberKey(member.projectId, member.subjectId);
          if (this.members.has(key)) return "member_exists";
          this.members.set(key, member);
          this.bumpMemoryProject(member.projectId, member.updatedAt);
          return "updated";
        }
        const inserted = await queryable.query(
          `insert into project_members
           (project_id, subject_id, role, created_at, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, subject_id) do nothing`,
          [
            member.projectId,
            member.subjectId,
            member.role,
            member.createdAt,
            member.updatedAt,
          ],
        );
        if (!inserted.rowCount) return "member_exists";
        await this.bumpProject(queryable, member.projectId, member.updatedAt);
        return "updated";
      },
    );
  }

  async updateProjectMemberRole(
    projectId: string,
    subjectId: string,
    role: ProjectRole,
    expectedVersion: number,
    updatedAt: string,
    audit: ProjectAuditRecord,
  ): Promise<ProjectMutationResult> {
    return this.mutateProject(
      projectId,
      expectedVersion,
      audit,
      async (queryable) => {
        const current = await this.member(queryable, projectId, subjectId);
        if (!current) return "member_not_found";
        if (
          current.role === "owner" &&
          role !== "owner" &&
          (await this.ownerCount(queryable, projectId)) === 1
        )
          return "last_owner_required";
        if (!queryable) {
          this.members.set(this.memberKey(projectId, subjectId), {
            ...current,
            role,
            updatedAt,
          });
          this.bumpMemoryProject(projectId, updatedAt);
        } else {
          await queryable.query(
            "update project_members set role = $3, updated_at = $4 where project_id = $1 and subject_id = $2",
            [projectId, subjectId, role, updatedAt],
          );
          await this.bumpProject(queryable, projectId, updatedAt);
        }
        return "updated";
      },
    );
  }

  async removeProjectMember(
    projectId: string,
    subjectId: string,
    expectedVersion: number,
    updatedAt: string,
    audit: ProjectAuditRecord,
  ): Promise<ProjectMutationResult> {
    return this.mutateProject(
      projectId,
      expectedVersion,
      audit,
      async (queryable) => {
        const current = await this.member(queryable, projectId, subjectId);
        if (!current) return "member_not_found";
        if (
          current.role === "owner" &&
          (await this.ownerCount(queryable, projectId)) === 1
        )
          return "last_owner_required";
        if (!queryable) {
          this.members.delete(this.memberKey(projectId, subjectId));
          this.bumpMemoryProject(projectId, updatedAt);
        } else {
          await queryable.query(
            "delete from project_members where project_id = $1 and subject_id = $2",
            [projectId, subjectId],
          );
          await this.bumpProject(queryable, projectId, updatedAt);
        }
        return "updated";
      },
    );
  }

  async transferProjectOwnership(
    projectId: string,
    fromSubjectId: string,
    toSubjectId: string,
    expectedVersion: number,
    updatedAt: string,
    audit: ProjectAuditRecord,
  ): Promise<ProjectMutationResult> {
    return this.mutateProject(
      projectId,
      expectedVersion,
      audit,
      async (queryable) => {
        const from = await this.member(queryable, projectId, fromSubjectId);
        const to = await this.member(queryable, projectId, toSubjectId);
        if (!from || !to || from.role !== "owner" || to.role === "owner")
          return "member_not_found";
        if (!queryable) {
          this.members.set(this.memberKey(projectId, fromSubjectId), {
            ...from,
            role: "maintainer",
            updatedAt,
          });
          this.members.set(this.memberKey(projectId, toSubjectId), {
            ...to,
            role: "owner",
            updatedAt,
          });
          this.bumpMemoryProject(projectId, updatedAt);
        } else {
          await queryable.query(
            `update project_members set role = case when subject_id = $2 then 'maintainer' else 'owner' end,
             updated_at = $4 where project_id = $1 and subject_id in ($2, $3)`,
            [projectId, fromSubjectId, toSubjectId, updatedAt],
          );
          await this.bumpProject(queryable, projectId, updatedAt);
        }
        return "updated";
      },
    );
  }

  async listProjectAuditLogs(
    projectId: string,
    limit: number,
    beforeId?: number,
  ) {
    const pool = this.poolProvider();
    if (!pool)
      return this.audits
        .filter(
          (audit) =>
            audit.projectId === projectId &&
            (!beforeId || (audit.id ?? 0) < beforeId),
        )
        .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
        .slice(0, limit);
    const result = await pool.query(
      `select * from project_audit_logs
       where project_id = $1 and ($2::bigint is null or id < $2)
       order by id desc limit $3`,
      [projectId, beforeId ?? null, limit],
    );
    return result.rows.map((row) => this.auditFromRow(row));
  }

  private async mutateProject(
    projectId: string,
    expectedVersion: number,
    audit: ProjectAuditRecord,
    mutation: (
      queryable: PoolClient | undefined,
    ) => Promise<Exclude<ProjectMutationResult["status"], "version_conflict">>,
  ): Promise<ProjectMutationResult> {
    const pool = this.poolProvider();
    if (!pool) {
      const previous = this.memoryLocks.get(projectId) ?? Promise.resolve();
      let release!: () => void;
      const currentLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.then(() => currentLock);
      this.memoryLocks.set(projectId, queued);
      await previous;
      try {
        const current = this.projects.get(projectId);
        if (!current || current.version !== expectedVersion)
          return { status: "version_conflict" };
        const status = await mutation(undefined);
        if (status === "updated") this.pushAudit(audit);
        return status === "updated"
          ? { status, project: this.projects.get(projectId)! }
          : { status };
      } finally {
        release();
        if (this.memoryLocks.get(projectId) === queued)
          this.memoryLocks.delete(projectId);
      }
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const locked = await connection.query(
        "select version from projects where project_id = $1 for update",
        [projectId],
      );
      if (Number(locked.rows[0]?.["version"]) !== expectedVersion) {
        await connection.query("rollback");
        return { status: "version_conflict" };
      }
      const status = await mutation(connection);
      if (status !== "updated") {
        await connection.query("rollback");
        return { status };
      }
      await this.insertAudit(connection, audit);
      const project = await connection.query(
        "select * from projects where project_id = $1",
        [projectId],
      );
      await connection.query("commit");
      return { status, project: this.projectFromRow(project.rows[0]!) };
    } catch (error) {
      await connection.query("rollback");
      throw error;
    } finally {
      connection.release();
    }
  }

  private async member(
    queryable: PoolClient | undefined,
    projectId: string,
    subjectId: string,
  ) {
    if (!queryable)
      return this.members.get(this.memberKey(projectId, subjectId)) ?? null;
    const result = await queryable.query(
      "select * from project_members where project_id = $1 and subject_id = $2",
      [projectId, subjectId],
    );
    return result.rowCount ? this.memberFromRow(result.rows[0]!) : null;
  }

  private async ownerCount(
    queryable: PoolClient | undefined,
    projectId: string,
  ) {
    if (!queryable)
      return [...this.members.values()].filter(
        (member) => member.projectId === projectId && member.role === "owner",
      ).length;
    const result = await queryable.query(
      "select count(*)::int as count from project_members where project_id = $1 and role = 'owner'",
      [projectId],
    );
    return Number(result.rows[0]?.["count"]);
  }

  private bumpMemoryProject(projectId: string, updatedAt: string) {
    const current = this.projects.get(projectId)!;
    this.projects.set(projectId, {
      ...current,
      version: current.version + 1,
      updatedAt,
    });
  }

  private async bumpProject(
    queryable: Queryable,
    projectId: string,
    updatedAt: string,
  ) {
    await queryable.query(
      "update projects set version = version + 1, updated_at = $2 where project_id = $1",
      [projectId, updatedAt],
    );
  }

  private memberKey(projectId: string, subjectId: string) {
    return `${projectId}\u0000${subjectId}`;
  }

  private async insertMember(
    queryable: Queryable,
    member: ProjectMemberRecord,
  ) {
    await queryable.query(
      `insert into project_members (project_id, subject_id, role, created_at, updated_at)
       values ($1, $2, $3, $4, $5)`,
      [
        member.projectId,
        member.subjectId,
        member.role,
        member.createdAt,
        member.updatedAt,
      ],
    );
  }

  private pushAudit(audit: ProjectAuditRecord) {
    this.audits.push({ ...audit, id: this.nextAuditId++ });
  }

  private async insertAudit(queryable: Queryable, audit: ProjectAuditRecord) {
    await queryable.query(
      `insert into project_audit_logs
         (project_id, client_id, revision_id, revision_number, secret_id,
          actor_subject_id, target_subject_id, action, changed_fields,
          previous_client_status, new_client_status, previous_revision_status,
          new_revision_status, previous_role, new_role, reason, source_ip, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        audit.projectId,
        audit.clientId ?? null,
        audit.revisionId ?? null,
        audit.revisionNumber ?? null,
        audit.secretId ?? null,
        audit.actorSubjectId,
        audit.targetSubjectId ?? null,
        audit.action,
        JSON.stringify(audit.changedFields),
        audit.previousClientStatus ?? null,
        audit.newClientStatus ?? null,
        audit.previousRevisionStatus ?? null,
        audit.newRevisionStatus ?? null,
        audit.previousRole ?? null,
        audit.newRole ?? null,
        audit.reason ?? null,
        audit.sourceIp ?? null,
        audit.createdAt,
      ],
    );
  }

  private projectFromRow(row: Record<string, unknown>): ProjectRecord {
    return {
      projectId: String(row["project_id"]),
      name: String(row["name"]),
      description: String(row["description"]),
      status: row["status"] as ProjectRecord["status"],
      createdBySubjectId:
        (row["created_by_subject_id"] as string | null) ?? null,
      version: Number(row["version"]),
      createdAt: new Date(row["created_at"] as string | Date).toISOString(),
      updatedAt: new Date(row["updated_at"] as string | Date).toISOString(),
    };
  }

  private memberFromRow(row: Record<string, unknown>): ProjectMemberRecord {
    return {
      projectId: String(row["project_id"]),
      subjectId: String(row["subject_id"]),
      role: row["role"] as ProjectRole,
      createdAt: new Date(row["created_at"] as string | Date).toISOString(),
      updatedAt: new Date(row["updated_at"] as string | Date).toISOString(),
    };
  }

  private auditFromRow(row: Record<string, unknown>): ProjectAuditRecord {
    return {
      id: Number(row["id"]),
      projectId: String(row["project_id"]),
      ...(row["client_id"] ? { clientId: String(row["client_id"]) } : {}),
      ...(row["revision_id"] ? { revisionId: Number(row["revision_id"]) } : {}),
      ...(row["revision_number"]
        ? { revisionNumber: Number(row["revision_number"]) }
        : {}),
      ...(row["secret_id"] ? { secretId: String(row["secret_id"]) } : {}),
      actorSubjectId: (row["actor_subject_id"] as string | null) ?? null,
      ...(row["target_subject_id"]
        ? { targetSubjectId: String(row["target_subject_id"]) }
        : {}),
      action: row["action"] as ProjectAuditRecord["action"],
      changedFields: Array.isArray(row["changed_fields"])
        ? (row["changed_fields"] as string[])
        : JSON.parse(String(row["changed_fields"] ?? "[]")),
      ...(row["previous_client_status"]
        ? {
            previousClientStatus: row[
              "previous_client_status"
            ] as ProjectAuditRecord["previousClientStatus"],
          }
        : {}),
      ...(row["new_client_status"]
        ? {
            newClientStatus: row[
              "new_client_status"
            ] as ProjectAuditRecord["newClientStatus"],
          }
        : {}),
      ...(row["previous_revision_status"]
        ? {
            previousRevisionStatus: row[
              "previous_revision_status"
            ] as ProjectAuditRecord["previousRevisionStatus"],
          }
        : {}),
      ...(row["new_revision_status"]
        ? {
            newRevisionStatus: row[
              "new_revision_status"
            ] as ProjectAuditRecord["newRevisionStatus"],
          }
        : {}),
      ...(row["previous_role"]
        ? { previousRole: row["previous_role"] as ProjectRole }
        : {}),
      ...(row["new_role"] ? { newRole: row["new_role"] as ProjectRole } : {}),
      ...(row["reason"] ? { reason: String(row["reason"]) } : {}),
      ...(row["source_ip"] ? { sourceIp: String(row["source_ip"]) } : {}),
      createdAt: new Date(row["created_at"] as string | Date).toISOString(),
    };
  }
}
