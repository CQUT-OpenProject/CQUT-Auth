import type {
  ProjectAuditRecord,
  ProjectMemberRecord,
  ProjectMutationResult,
  ProjectRecord,
  ProjectRepository,
  ProjectRole,
} from "../persistence/contracts.js";
import { SYSTEM_PROJECT_ID } from "../persistence/contracts.js";
import { randomId } from "../utils.js";
import { ClientManagementError } from "../management/management-error.js";
import { ProjectAccessService, type ProjectActor } from "./project-access.js";

export class ProjectManagementService {
  readonly access: ProjectAccessService;

  constructor(
    private readonly repository: ProjectRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly createProjectId: () => string = () =>
      randomId("project", 18),
    private readonly limits: {
      maxActiveProjects?: number;
      adminQuotaExempt?: boolean;
    } = {},
  ) {
    this.access = new ProjectAccessService(repository);
  }

  async list(actor: ProjectActor) {
    return Promise.all(
      (
        await this.repository.listProjectsForSubject(
          actor.subjectId,
          actor.isAdmin,
        )
      ).map(async ({ project, role }) =>
        this.publicProject(actor, project, role),
      ),
    );
  }

  async get(actor: ProjectActor, projectId: string) {
    const { project, role } = await this.access.require(
      actor,
      projectId,
      "view",
    );
    return this.publicProject(actor, project, role);
  }

  async create(actor: ProjectActor, raw: unknown) {
    const body = this.object(raw, ["name", "description"]);
    const timestamp = this.now().toISOString();
    const project: ProjectRecord = {
      projectId: this.createProjectId(),
      name: this.text(body["name"], "name", 1, 100),
      description: this.text(body["description"] ?? "", "description", 0, 1000),
      status: "active",
      createdBySubjectId: actor.subjectId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const owner: ProjectMemberRecord = {
      projectId: project.projectId,
      subjectId: actor.subjectId,
      role: "owner",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created = await this.repository.createProject(
      project,
      owner,
      this.audit(actor, project.projectId, "project.created", timestamp, {
        changedFields: ["name", "description", "status"],
      }),
      actor.isAdmin && (this.limits.adminQuotaExempt ?? true)
        ? undefined
        : { maxActiveProjects: this.limits.maxActiveProjects ?? 5 },
    );
    if (!created)
      throw new ClientManagementError(
        409,
        "project_quota_exceeded",
        "active project quota exceeded for this subject",
      );
    return this.publicProject(actor, created, "owner");
  }

  async update(actor: ProjectActor, projectId: string, raw: unknown) {
    const { project } = await this.access.require(
      actor,
      projectId,
      "manage_project",
    );
    const body = this.object(raw, [
      "expectedProjectVersion",
      "name",
      "description",
      "status",
    ]);
    const expectedVersion = this.version(body["expectedProjectVersion"]);
    const name =
      body["name"] === undefined
        ? project.name
        : this.text(body["name"], "name", 1, 100);
    const description =
      body["description"] === undefined
        ? project.description
        : this.text(body["description"], "description", 0, 1000);
    const status =
      body["status"] === undefined ? project.status : body["status"];
    if (status !== "active" && status !== "archived") this.invalid("status");
    if (projectId === SYSTEM_PROJECT_ID && status === "archived")
      throw new ClientManagementError(
        409,
        "system_project",
        "system project cannot be archived",
      );
    if (
      project.status === "archived" ||
      (project.status === "active" &&
        status === "active" &&
        name === project.name &&
        description === project.description)
    )
      throw new ClientManagementError(
        400,
        "invalid_request",
        "project must change",
      );
    const timestamp = this.now().toISOString();
    const action =
      status === "archived" ? "project.archived" : "project.updated";
    const changedFields = [
      ...(name !== project.name ? ["name"] : []),
      ...(description !== project.description ? ["description"] : []),
      ...(status !== project.status ? ["status"] : []),
    ];
    return this.updated(
      actor,
      await this.repository.updateProject(
        projectId,
        expectedVersion,
        { name, description, status, updatedAt: timestamp },
        this.audit(actor, projectId, action, timestamp, { changedFields }),
      ),
    );
  }

  async members(actor: ProjectActor, projectId: string) {
    this.rejectSystemMembers(projectId);
    await this.access.require(actor, projectId, "view");
    return this.repository.listProjectMembers(projectId);
  }

  async addMember(actor: ProjectActor, projectId: string, raw: unknown) {
    this.rejectSystemMembers(projectId);
    await this.access.require(actor, projectId, "manage_members");
    const body = this.object(raw, [
      "subjectId",
      "role",
      "expectedProjectVersion",
    ]);
    const timestamp = this.now().toISOString();
    const subjectId = this.text(body["subjectId"], "subjectId", 1, 200);
    const role = this.role(body["role"]);
    return this.updated(
      actor,
      await this.repository.addProjectMember(
        {
          projectId,
          subjectId,
          role,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        this.version(body["expectedProjectVersion"]),
        this.audit(actor, projectId, "project.member_added", timestamp, {
          targetSubjectId: subjectId,
          newRole: role,
          changedFields: ["role"],
        }),
      ),
    );
  }

  async updateMember(
    actor: ProjectActor,
    projectId: string,
    subjectId: string,
    raw: unknown,
  ) {
    this.rejectSystemMembers(projectId);
    await this.access.require(actor, projectId, "manage_members");
    const body = this.object(raw, ["role", "expectedProjectVersion"]);
    const members = await this.repository.listProjectMembers(projectId);
    const current = members.find((member) => member.subjectId === subjectId);
    if (!current)
      throw new ClientManagementError(404, "not_found", "member not found");
    const role = this.role(body["role"]);
    const timestamp = this.now().toISOString();
    return this.updated(
      actor,
      await this.repository.updateProjectMemberRole(
        projectId,
        subjectId,
        role,
        this.version(body["expectedProjectVersion"]),
        timestamp,
        this.audit(actor, projectId, "project.member_role_changed", timestamp, {
          targetSubjectId: subjectId,
          previousRole: current.role,
          newRole: role,
          changedFields: ["role"],
        }),
      ),
    );
  }

  async removeMember(
    actor: ProjectActor,
    projectId: string,
    subjectId: string,
    raw: unknown,
  ) {
    this.rejectSystemMembers(projectId);
    await this.access.require(actor, projectId, "manage_members");
    const body = this.object(raw, ["expectedProjectVersion"]);
    const members = await this.repository.listProjectMembers(projectId);
    const current = members.find((member) => member.subjectId === subjectId);
    if (!current)
      throw new ClientManagementError(404, "not_found", "member not found");
    const timestamp = this.now().toISOString();
    return this.updated(
      actor,
      await this.repository.removeProjectMember(
        projectId,
        subjectId,
        this.version(body["expectedProjectVersion"]),
        timestamp,
        this.audit(actor, projectId, "project.member_removed", timestamp, {
          targetSubjectId: subjectId,
          previousRole: current.role,
          changedFields: ["role"],
        }),
      ),
    );
  }

  async transfer(actor: ProjectActor, projectId: string, raw: unknown) {
    this.rejectSystemMembers(projectId);
    await this.access.require(actor, projectId, "manage_members");
    const body = this.object(raw, [
      "fromSubjectId",
      "toSubjectId",
      "expectedProjectVersion",
    ]);
    const fromSubjectId = this.text(
      body["fromSubjectId"],
      "fromSubjectId",
      1,
      200,
    );
    const toSubjectId = this.text(body["toSubjectId"], "toSubjectId", 1, 200);
    if (fromSubjectId === toSubjectId) this.invalid("toSubjectId");
    const timestamp = this.now().toISOString();
    const members = await this.repository.listProjectMembers(projectId);
    const source = members.find(
      (member) => member.subjectId === fromSubjectId && member.role === "owner",
    );
    const target = members.find((member) => member.subjectId === toSubjectId);
    if (!source || !target || target.role === "owner")
      throw new ClientManagementError(
        404,
        "not_found",
        "transfer target not found",
      );
    return this.updated(
      actor,
      await this.repository.transferProjectOwnership(
        projectId,
        fromSubjectId,
        toSubjectId,
        this.version(body["expectedProjectVersion"]),
        timestamp,
        [
          this.audit(
            actor,
            projectId,
            "project.ownership_transferred",
            timestamp,
            {
              targetSubjectId: toSubjectId,
              changedFields: ["role"],
            },
          ),
          this.audit(
            actor,
            projectId,
            "project.member_role_changed",
            timestamp,
            {
              targetSubjectId: fromSubjectId,
              previousRole: "owner",
              newRole: "maintainer",
              changedFields: ["role"],
            },
          ),
          this.audit(
            actor,
            projectId,
            "project.member_role_changed",
            timestamp,
            {
              targetSubjectId: toSubjectId,
              previousRole: target.role,
              newRole: "owner",
              changedFields: ["role"],
            },
          ),
        ],
      ),
    );
  }

  async audits(
    actor: ProjectActor,
    projectId: string,
    limit: number,
    beforeId?: number,
  ) {
    await this.access.require(actor, projectId, "view");
    return this.repository.listProjectAuditLogs(projectId, limit, beforeId);
  }

  private async updated(actor: ProjectActor, result: ProjectMutationResult) {
    if (result.status === "version_conflict") this.conflict();
    if (result.status === "last_owner_required")
      throw new ClientManagementError(
        409,
        result.status,
        "project must retain at least one owner",
      );
    if (result.status === "subject_not_found")
      throw new ClientManagementError(
        404,
        result.status,
        "active subject not found",
      );
    if (result.status === "member_not_found")
      throw new ClientManagementError(404, "not_found", "member not found");
    if (result.status === "member_exists")
      throw new ClientManagementError(
        409,
        result.status,
        "member already exists",
      );
    const role = await this.repository.findProjectRole(
      result.project.projectId,
      actor.subjectId,
    );
    return this.publicProject(actor, result.project, role);
  }

  private publicProject(
    actor: ProjectActor,
    project: ProjectRecord,
    role: ProjectRole | null,
  ) {
    return {
      projectId: project.projectId,
      name: project.name,
      description: project.description,
      status: project.status,
      createdBySubjectId: project.createdBySubjectId,
      version: project.version,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      role,
      capabilities: this.access.capabilities(actor, project, role),
    };
  }

  private audit(
    actor: ProjectActor,
    projectId: string,
    action: ProjectAuditRecord["action"],
    createdAt: string,
    values: Partial<ProjectAuditRecord>,
  ): ProjectAuditRecord {
    return {
      projectId,
      actorSubjectId: actor.subjectId,
      action,
      changedFields: [],
      ...(actor.sourceIp ? { sourceIp: actor.sourceIp } : {}),
      createdAt,
      ...values,
    };
  }

  private object(raw: unknown, allowed: string[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      this.invalid();
    const body = raw as Record<string, unknown>;
    const unexpected = Object.keys(body).find((key) => !allowed.includes(key));
    if (unexpected) this.invalid(unexpected);
    return body;
  }

  private text(value: unknown, field: string, min: number, max: number) {
    if (typeof value !== "string") this.invalid(field);
    const normalized = value.trim();
    if (normalized.length < min || normalized.length > max) this.invalid(field);
    return normalized;
  }

  private version(value: unknown) {
    if (!Number.isInteger(value) || Number(value) <= 0)
      this.invalid("expectedProjectVersion");
    return Number(value);
  }

  private role(value: unknown): ProjectRole {
    if (value !== "owner" && value !== "maintainer" && value !== "viewer")
      this.invalid("role");
    return value;
  }

  private invalid(field?: string): never {
    throw new ClientManagementError(
      400,
      "invalid_request",
      field ? `invalid ${field}` : "request body must be an object",
      field,
    );
  }

  private conflict(): never {
    throw new ClientManagementError(
      409,
      "version_conflict",
      "project changed concurrently; reload and retry",
    );
  }

  private rejectSystemMembers(projectId: string) {
    if (projectId === SYSTEM_PROJECT_ID)
      throw new ClientManagementError(404, "not_found", "project not found");
  }
}
