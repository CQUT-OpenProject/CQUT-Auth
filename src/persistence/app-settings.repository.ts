import type { Pool } from "pg";
import type {
  AppSettingRecord,
  AppSettingsRepository,
} from "./contracts.js";

export class AppSettingsRepositoryImpl implements AppSettingsRepository {
  private readonly settings = new Map<string, AppSettingRecord>();

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
    return row ? this.mapRow(row) : null;
  }

  async upsertAppSetting(input: {
    key: string;
    valueCiphertext: string;
    updatedAt: string;
  }): Promise<AppSettingRecord> {
    const pool = this.poolProvider();
    if (!pool) {
      const existing = this.settings.get(input.key);
      const record: AppSettingRecord = {
        key: input.key,
        valueCiphertext: input.valueCiphertext,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? input.updatedAt,
        updatedAt: input.updatedAt,
      };
      this.settings.set(input.key, record);
      return record;
    }
    const result = await pool.query(
      `
      insert into app_settings (key, value_ciphertext, version, updated_at)
      values ($1, $2, 1, $3::timestamptz)
      on conflict (key) do update
      set value_ciphertext = excluded.value_ciphertext,
          version = app_settings.version + 1,
          updated_at = excluded.updated_at
      returning *
      `,
      [input.key, input.valueCiphertext, input.updatedAt],
    );
    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: Record<string, unknown>): AppSettingRecord {
    return {
      key: String(row["key"]),
      valueCiphertext: String(row["value_ciphertext"]),
      version: Number(row["version"]),
      createdAt: (row["created_at"] as Date).toISOString(),
      updatedAt: (row["updated_at"] as Date).toISOString(),
    };
  }
}
