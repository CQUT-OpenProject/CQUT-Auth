import type { Pool, PoolClient } from "pg";
import type {
  AppSettingAuditRecord,
  AppSettingMutationResult,
  AppSettingRecord,
  AppSettingsRepository,
} from "./contracts.js";

type SaveAppSettingInput = Parameters<
  AppSettingsRepository["saveAppSetting"]
>[0];

export class AppSettingsRepositoryImpl implements AppSettingsRepository {
  private readonly settings = new Map<string, AppSettingRecord>();
  private readonly audits: AppSettingAuditRecord[] = [];
  private nextAuditId = 1;

  constructor(private readonly poolProvider: () => Pool | undefined) {}

  async getAppSetting(key: string): Promise<AppSettingRecord | null> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.settings.get(key) ?? null;
    }
    const result = await pool.query(
      "select * from app_settings where key = $1 limit 1",
      [key],
    );
    const row = result.rows[0];
    return row ? this.mapSettingRow(row) : null;
  }

  async saveAppSetting(
    input: SaveAppSettingInput,
  ): Promise<AppSettingMutationResult> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.saveInMemory(input);
    }
    const connection = await pool.connect();
    try {
      await connection.query("begin");
      const record = await this.saveWithConnection(connection, input);
      if (!record) {
        await connection.query("rollback");
        return { status: "version_conflict" };
      }
      await this.insertAudit(connection, input, record.version);
      await connection.query("commit");
      return { status: "updated", record };
    } catch (error) {
      await connection.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async listAppSettingAuditLogs(
    key: string,
    limit: number,
  ): Promise<AppSettingAuditRecord[]> {
    const pool = this.poolProvider();
    if (!pool) {
      return this.audits
        .filter((audit) => audit.settingKey === key)
        .slice(-limit)
        .reverse();
    }
    const result = await pool.query(
      `select * from app_settings_audit_logs
       where setting_key = $1
       order by id desc
       limit $2`,
      [key, limit],
    );
    return result.rows.map((row) => this.mapAuditRow(row));
  }

  private saveInMemory(input: SaveAppSettingInput): AppSettingMutationResult {
    const existing = this.settings.get(input.key);
    if ((existing?.version ?? 0) !== input.expectedVersion) {
      return { status: "version_conflict" };
    }
    const record: AppSettingRecord = {
      key: input.key,
      valueCiphertext: input.valueCiphertext,
      version: input.expectedVersion + 1,
      createdAt: existing?.createdAt ?? input.updatedAt,
      updatedAt: input.updatedAt,
    };
    this.settings.set(input.key, record);
    this.audits.push({
      id: this.nextAuditId++,
      settingKey: input.key,
      ...input.audit,
      previousVersion: input.expectedVersion,
      newVersion: record.version,
    });
    return { status: "updated", record };
  }

  private async saveWithConnection(
    connection: PoolClient,
    input: SaveAppSettingInput,
  ): Promise<AppSettingRecord | null> {
    if (input.expectedVersion === 0) {
      const result = await connection.query(
        `insert into app_settings (key, value_ciphertext, version, updated_at)
         values ($1, $2, 1, $3::timestamptz)
         on conflict (key) do nothing
         returning *`,
        [input.key, input.valueCiphertext, input.updatedAt],
      );
      const row = result.rows[0];
      return row ? this.mapSettingRow(row) : null;
    }
    const result = await connection.query(
      `update app_settings
       set value_ciphertext = $2,
           version = version + 1,
           updated_at = $3::timestamptz
       where key = $1 and version = $4
       returning *`,
      [
        input.key,
        input.valueCiphertext,
        input.updatedAt,
        input.expectedVersion,
      ],
    );
    const row = result.rows[0];
    return row ? this.mapSettingRow(row) : null;
  }

  private async insertAudit(
    connection: PoolClient,
    input: SaveAppSettingInput,
    newVersion: number,
  ): Promise<void> {
    await connection.query(
      `insert into app_settings_audit_logs (
         setting_key, actor_subject_id, action, changed_fields,
         previous_values, new_values, secrets_replaced,
         previous_version, new_version, source_ip, created_at
       ) values (
         $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb,
         $8, $9, $10, $11::timestamptz
       )`,
      [
        input.key,
        input.audit.actorSubjectId,
        input.audit.action,
        JSON.stringify(input.audit.changedFields),
        JSON.stringify(input.audit.previousValues),
        JSON.stringify(input.audit.newValues),
        JSON.stringify(input.audit.secretsReplaced),
        input.expectedVersion,
        newVersion,
        input.audit.sourceIp ?? null,
        input.audit.createdAt,
      ],
    );
  }

  private mapSettingRow(row: Record<string, unknown>): AppSettingRecord {
    return {
      key: String(row["key"]),
      valueCiphertext: String(row["value_ciphertext"]),
      version: Number(row["version"]),
      createdAt: dateString(row["created_at"]),
      updatedAt: dateString(row["updated_at"]),
    };
  }

  private mapAuditRow(row: Record<string, unknown>): AppSettingAuditRecord {
    return {
      id: Number(row["id"]),
      settingKey: String(row["setting_key"]),
      actorSubjectId:
        row["actor_subject_id"] === null
          ? null
          : String(row["actor_subject_id"]),
      action: row["action"] as AppSettingAuditRecord["action"],
      changedFields: row["changed_fields"] as string[],
      previousValues: row["previous_values"] as Record<string, unknown>,
      newValues: row["new_values"] as Record<string, unknown>,
      secretsReplaced: row["secrets_replaced"] as Record<string, boolean>,
      previousVersion: Number(row["previous_version"]),
      newVersion: Number(row["new_version"]),
      ...(row["source_ip"] === null
        ? {}
        : { sourceIp: String(row["source_ip"]) }),
      createdAt: dateString(row["created_at"]),
    };
  }
}

function dateString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
