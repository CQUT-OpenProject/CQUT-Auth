import type { Pool } from "pg";
import type { OidcSigningKeyRecord, SigningKeyRepository } from "./contracts.js";
import type { JwkCipherServiceImpl } from "./jwk-cipher.service.js";

export class SigningKeyRepositoryImpl implements SigningKeyRepository {
  private readonly signingKeys = new Map<string, OidcSigningKeyRecord>();

  constructor(
    private readonly poolProvider: () => Pool | undefined,
    private readonly jwkCipherService: JwkCipherServiceImpl
  ) {}

  async upsertSigningKey(key: OidcSigningKeyRecord): Promise<OidcSigningKeyRecord> {
    const pool = this.poolProvider();
    if (!pool) {
      this.signingKeys.set(key.kid, key);
      return key;
    }
    await pool.query(
      `
      insert into oidc_signing_keys (
        kid,
        alg,
        use,
        public_jwk,
        private_jwk_ciphertext,
        status,
        created_at,
        activated_at,
        retired_at
      )
      values ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)
      on conflict (kid) do update
      set alg = excluded.alg,
          use = excluded.use,
          public_jwk = excluded.public_jwk,
          private_jwk_ciphertext = excluded.private_jwk_ciphertext,
          status = excluded.status,
          activated_at = excluded.activated_at,
          retired_at = excluded.retired_at
      `,
      [
        key.kid,
        key.alg,
        key.use,
        JSON.stringify(key.publicJwk),
        key.privateJwkCiphertext,
        key.status,
        key.createdAt,
        key.activatedAt ?? null,
        key.retiredAt ?? null
      ]
    );
    return key;
  }

  async listSigningKeys(statuses: Array<OidcSigningKeyRecord["status"]> = ["active", "retiring"]) {
    const pool = this.poolProvider();
    if (!pool) {
      return [...this.signingKeys.values()]
        .filter((item) => statuses.includes(item.status))
        .sort(
          (left, right) =>
            left.status.localeCompare(right.status) || right.createdAt.localeCompare(left.createdAt)
        );
    }
    const result = await pool.query(
      `
      select * from oidc_signing_keys
      where status = any($1::text[])
      order by case when status = 'active' then 0 else 1 end, created_at desc
      `,
      [statuses]
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      kid: String(row["kid"]),
      alg: String(row["alg"]),
      use: String(row["use"]),
      publicJwk: row["public_jwk"] as JsonWebKey,
      privateJwkCiphertext: String(row["private_jwk_ciphertext"]),
      status: row["status"] as OidcSigningKeyRecord["status"],
      createdAt: (row["created_at"] as Date).toISOString(),
      activatedAt: row["activated_at"] ? (row["activated_at"] as Date).toISOString() : undefined,
      retiredAt: row["retired_at"] ? (row["retired_at"] as Date).toISOString() : undefined
    }));
  }

  async loadPrivateSigningJwks(statuses: Array<OidcSigningKeyRecord["status"]> = ["active", "retiring"]) {
    const keys = await this.listSigningKeys(statuses);
    return keys.map((key) => ({
      ...this.jwkCipherService.decryptPrivateJwk(key.privateJwkCiphertext),
      use: key.use,
      alg: key.alg,
      kid: key.kid
    })) as Array<JsonWebKey & { kid: string; alg: string; use: string }>;
  }
}
