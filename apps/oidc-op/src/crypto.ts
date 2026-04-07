import {
  createCipheriv,
  createDecipheriv,
  scrypt,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const SCRYPT_DIGEST_PREFIX = "scrypt";
const SCRYPT_DEFAULTS = {
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16
} as const;

const ENCRYPTION_SCHEME_VERSION = "v2";
const ENCRYPTION_SCHEME_KDF = "scrypt";
const ENCRYPTION_MAX_MEMORY = 64 * 1024 * 1024;
const DERIVED_KEY_CACHE_TTL_MS = 30_000;
const DERIVED_KEY_CACHE_MAX_ENTRIES = 1024;

type DerivedKeyCacheEntry = {
  key: Buffer;
  expiresAt: number;
};

const derivedKeyCache = new Map<string, DerivedKeyCacheEntry>();

function encodeBase64Url(raw: Buffer) {
  return raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

type ParsedScryptDigest = {
  N: number;
  r: number;
  p: number;
  keyLength: number;
  salt: Buffer;
  digest: Buffer;
};

type ParsedEncryptedPayload = {
  N: number;
  r: number;
  p: number;
  keyLength: number;
  salt: Buffer;
  encrypted: Buffer;
};

function parsePositiveInteger(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseScryptDigest(encodedDigest: string): ParsedScryptDigest | null {
  const segments = encodedDigest.split("$");
  if (segments.length !== 4 || segments[0] !== SCRYPT_DIGEST_PREFIX) {
    return null;
  }
  const parameterPairs = new Map<string, string>();
  for (const entry of segments[1]!.split(",")) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      return null;
    }
    parameterPairs.set(entry.slice(0, equalsIndex), entry.slice(equalsIndex + 1));
  }
  const N = parsePositiveInteger(parameterPairs.get("N") ?? "");
  const r = parsePositiveInteger(parameterPairs.get("r") ?? "");
  const p = parsePositiveInteger(parameterPairs.get("p") ?? "");
  const keyLength = parsePositiveInteger(parameterPairs.get("keylen") ?? "");
  if (!N || !r || !p || !keyLength) {
    return null;
  }
  try {
    const salt = decodeBase64Url(segments[2] ?? "");
    const digest = decodeBase64Url(segments[3] ?? "");
    if (salt.length === 0 || digest.length !== keyLength) {
      return null;
    }
    return {
      N,
      r,
      p,
      keyLength,
      salt,
      digest
    };
  } catch {
    return null;
  }
}

function serializeScryptParams(N: number, r: number, p: number, keyLength: number) {
  return `N=${N},r=${r},p=${p},keylen=${keyLength}`;
}

function parseScryptParams(encoded: string) {
  const parameterPairs = new Map<string, string>();
  for (const entry of encoded.split(",")) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      return null;
    }
    parameterPairs.set(entry.slice(0, equalsIndex), entry.slice(equalsIndex + 1));
  }
  const N = parsePositiveInteger(parameterPairs.get("N") ?? "");
  const r = parsePositiveInteger(parameterPairs.get("r") ?? "");
  const p = parsePositiveInteger(parameterPairs.get("p") ?? "");
  const keyLength = parsePositiveInteger(parameterPairs.get("keylen") ?? "");
  if (!N || !r || !p || !keyLength) {
    return null;
  }
  return { N, r, p, keyLength };
}

function derivedKeyCacheKey(
  secret: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  keyLength: number
) {
  return `${N}:${r}:${p}:${keyLength}:${encodeBase64Url(salt)}:${secret}`;
}

function pruneDerivedKeyCache(now: number) {
  for (const [cacheKey, entry] of derivedKeyCache.entries()) {
    if (entry.expiresAt <= now) {
      derivedKeyCache.delete(cacheKey);
    }
  }
  while (derivedKeyCache.size > DERIVED_KEY_CACHE_MAX_ENTRIES) {
    const oldest = derivedKeyCache.keys().next();
    if (oldest.done) {
      return;
    }
    derivedKeyCache.delete(oldest.value);
  }
}

async function deriveScryptKey(
  secret: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  keyLength: number
) {
  const now = Date.now();
  const cacheKey = derivedKeyCacheKey(secret, salt, N, r, p, keyLength);
  const cached = derivedKeyCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.key;
  }
  if (cached) {
    derivedKeyCache.delete(cacheKey);
  }

  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      secret,
      salt,
      keyLength,
      {
        N,
        r,
        p,
        maxmem: ENCRYPTION_MAX_MEMORY
      },
      (error, derived) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derived as Buffer);
      }
    );
  });
  derivedKeyCache.set(cacheKey, {
    key,
    expiresAt: now + DERIVED_KEY_CACHE_TTL_MS
  });
  if (derivedKeyCache.size > DERIVED_KEY_CACHE_MAX_ENTRIES) {
    pruneDerivedKeyCache(now);
  }
  return key;
}

function parseEncryptedPayload(ciphertext: string): ParsedEncryptedPayload {
  const segments = ciphertext.split("$");
  if (segments.length !== 5) {
    throw new Error("invalid ciphertext format");
  }
  if (segments[0] !== ENCRYPTION_SCHEME_VERSION || segments[1] !== ENCRYPTION_SCHEME_KDF) {
    throw new Error("unsupported ciphertext version");
  }
  const params = parseScryptParams(segments[2] ?? "");
  if (!params) {
    throw new Error("invalid ciphertext params");
  }
  if (
    params.N !== SCRYPT_DEFAULTS.N ||
    params.r !== SCRYPT_DEFAULTS.r ||
    params.p !== SCRYPT_DEFAULTS.p ||
    params.keyLength !== SCRYPT_DEFAULTS.keyLength
  ) {
    throw new Error("unsupported ciphertext params");
  }
  const salt = decodeBase64Url(segments[3] ?? "");
  const encrypted = decodeBase64Url(segments[4] ?? "");
  if (salt.length !== SCRYPT_DEFAULTS.saltLength || encrypted.length <= 28) {
    throw new Error("invalid ciphertext payload");
  }
  return {
    ...params,
    salt,
    encrypted
  };
}

export async function createClientSecretDigest(secret: string): Promise<string> {
  const salt = randomBytes(SCRYPT_DEFAULTS.saltLength);
  const digest = await deriveScryptKey(
    secret,
    salt,
    SCRYPT_DEFAULTS.N,
    SCRYPT_DEFAULTS.r,
    SCRYPT_DEFAULTS.p,
    SCRYPT_DEFAULTS.keyLength
  );
  return [
    SCRYPT_DIGEST_PREFIX,
    serializeScryptParams(
      SCRYPT_DEFAULTS.N,
      SCRYPT_DEFAULTS.r,
      SCRYPT_DEFAULTS.p,
      SCRYPT_DEFAULTS.keyLength
    ),
    encodeBase64Url(salt),
    encodeBase64Url(digest)
  ].join("$");
}

export async function verifyClientSecretDigest(secret: string, encodedDigest: string): Promise<boolean> {
  const parsed = parseScryptDigest(encodedDigest);
  if (!parsed) {
    return false;
  }
  let computed: Buffer;
  try {
    computed = await deriveScryptKey(secret, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.keyLength);
  } catch {
    return false;
  }
  if (computed.length !== parsed.digest.length) {
    return false;
  }
  return timingSafeEqual(computed, parsed.digest);
}

export async function encryptJson(secret: string, payload: object): Promise<string> {
  const salt = randomBytes(SCRYPT_DEFAULTS.saltLength);
  const iv = randomBytes(12);
  const key = await deriveScryptKey(
    secret,
    salt,
    SCRYPT_DEFAULTS.N,
    SCRYPT_DEFAULTS.r,
    SCRYPT_DEFAULTS.p,
    SCRYPT_DEFAULTS.keyLength
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_SCHEME_VERSION,
    ENCRYPTION_SCHEME_KDF,
    serializeScryptParams(
      SCRYPT_DEFAULTS.N,
      SCRYPT_DEFAULTS.r,
      SCRYPT_DEFAULTS.p,
      SCRYPT_DEFAULTS.keyLength
    ),
    encodeBase64Url(salt),
    encodeBase64Url(Buffer.concat([iv, tag, ciphertext]))
  ].join("$");
}

export async function decryptJson<T>(secret: string, ciphertext: string): Promise<T> {
  const parsed = parseEncryptedPayload(ciphertext);
  const raw = parsed.encrypted;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const payload = raw.subarray(28);
  const key = await deriveScryptKey(
    secret,
    parsed.salt,
    parsed.N,
    parsed.r,
    parsed.p,
    parsed.keyLength
  );
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as T;
}
