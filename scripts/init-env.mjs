import { execFileSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(projectRoot, "deploy/.env.example");
const defaultOutputPath = resolve(projectRoot, "deploy/.env");
const clientsTemplatePath = resolve(projectRoot, "deploy/oidc-clients.json.example");
const defaultClientsOutputPath = resolve(projectRoot, "deploy/oidc-clients.json");
const certDir = resolve(projectRoot, "deploy/certs");
const defaultCertPath = resolve(certDir, "fullchain.pem");
const defaultKeyPath = resolve(certDir, "privkey.pem");
const allowedProfiles = new Set(["production", "local", "test"]);

const args = process.argv.slice(2);
const outputPath = getArgValue("--write");
const force = args.includes("--force");
const printToStdout = args.includes("--stdout");
const skipCerts = args.includes("--skip-certs");
const withCerts = args.includes("--with-certs");
const profile = getArgValue("--profile") ?? "production";
const demoBaseUrl = normalizeOptionalAbsoluteUrl(getArgValue("--demo-base-url"));
const issuerOverride = normalizeOptionalAbsoluteUrl(getArgValue("--issuer"));

if (!allowedProfiles.has(profile)) {
  throw new Error("--profile must be one of: production, local, test");
}
if (skipCerts && withCerts) {
  throw new Error("--skip-certs and --with-certs cannot be used together");
}

const certHostDefault = profile === "test" ? "localhost" : "verify.local";
const certHost = getArgValue("--cert-host") ?? certHostDefault;
const certDays = Number(getArgValue("--cert-days") ?? "365");
const generatedDemoClientSecret = randomToken(24);
if (!Number.isInteger(certDays) || certDays <= 0) {
  throw new Error("--cert-days must be a positive integer");
}

const randomReplacements = {
  POSTGRES_PASSWORD: randomToken(24),
  OIDC_KEY_ENCRYPTION_SECRET: randomToken(32),
  OIDC_ARTIFACT_ENCRYPTION_SECRET: randomToken(32),
  OIDC_COOKIE_KEYS: `${randomToken(32)},${randomToken(32)}`,
  OIDC_CSRF_SIGNING_SECRET: randomToken(32)
};

const profileReplacements = {
  production: {},
  local: {
    APP_ENV: "development",
    OIDC_ISSUER: issuerOverride ?? "https://verify.local",
    OIDC_COOKIE_SECURE: "true",
    SERVER_NAME: deriveServerName(issuerOverride ?? "https://verify.local"),
    OIDC_EMAIL_VERIFICATION_ENABLED: "true",
    OIDC_EMAIL_FROM: "CQUT Auth <no-reply@auth-cqut.ciallichannel.com>"
  },
  test: {
    APP_ENV: "test",
    OIDC_ISSUER: issuerOverride ?? "http://localhost",
    OIDC_COOKIE_SECURE: "false",
    SERVER_NAME: deriveServerName(issuerOverride ?? "http://localhost"),
    OIDC_EMAIL_VERIFICATION_ENABLED: "true",
    OIDC_EMAIL_FROM: "CQUT Auth <no-reply@auth-cqut.ciallichannel.com>"
  }
};

const replacements = {
  ...randomReplacements,
  ...profileReplacements[profile],
  ...(issuerOverride
    ? {
        OIDC_ISSUER: issuerOverride,
        SERVER_NAME: deriveServerName(issuerOverride)
      }
    : {})
};

const template = readFileSync(templatePath, "utf8");
const rendered = template
  .split(/\r?\n/)
  .map((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) {
      return line;
    }
    const [, key] = match;
    const replacement = replacements[key];
    return replacement ? `${key}=${replacement}` : line;
  })
  .join("\n");

if (outputPath) {
  writeOutput(resolve(projectRoot, outputPath));
} else if (printToStdout) {
  process.stdout.write(`${rendered}\n`);
} else {
  writeOutput(defaultOutputPath);
}

if (!printToStdout) {
  writeClientsConfig(defaultClientsOutputPath);
}

if (shouldGenerateCertificates()) {
  generateSelfSignedCertificate();
}

function shouldGenerateCertificates() {
  if (printToStdout) {
    return false;
  }
  if (skipCerts) {
    return false;
  }
  if (withCerts) {
    return true;
  }
  return profile !== "test";
}

function writeOutput(targetPath) {
  if (existsSync(targetPath) && !force) {
    throw new Error(`Refusing to overwrite existing file: ${targetPath}. Re-run with --force if needed.`);
  }

  writeFileSync(targetPath, `${rendered}\n`, { encoding: "utf8" });
  process.stdout.write(`Initialized deploy env file: ${targetPath} (profile=${profile})\n`);
}

function writeClientsConfig(targetPath) {
  if (existsSync(targetPath) && !force) {
    throw new Error(`Refusing to overwrite existing file: ${targetPath}. Re-run with --force if needed.`);
  }
  const template = readFileSync(clientsTemplatePath, "utf8");
  const parsedTemplate = JSON.parse(template);
  if (!parsedTemplate || !Array.isArray(parsedTemplate.clients) || parsedTemplate.clients.length === 0) {
    throw new Error("deploy/oidc-clients.json.example must contain at least one client template");
  }
  const baseClient = parsedTemplate.clients[0];
  const resolvedDemoBaseUrl = demoBaseUrl ?? defaultDemoBaseUrlForProfile(profile);
  const redirectUri = new URL("/callback", ensureTrailingSlash(resolvedDemoBaseUrl)).toString();
  const postLogoutRedirectUri = new URL(
    "/logout-complete",
    ensureTrailingSlash(resolvedDemoBaseUrl)
  ).toString();

  const renderedClients = {
    clients: [
      {
        ...baseClient,
        clientId: "demo-site",
        clientSecretDigest: createClientSecretDigest(generatedDemoClientSecret),
        redirectUris: [redirectUri],
        postLogoutRedirectUris: [postLogoutRedirectUri]
      }
    ]
  };
  writeFileSync(targetPath, `${JSON.stringify(renderedClients, null, 2)}\n`, { encoding: "utf8" });
  process.stdout.write(`Initialized OIDC clients file: ${targetPath} (profile=${profile})\n`);
  process.stdout.write(`Demo-site client secret (write down once): ${generatedDemoClientSecret}\n`);
}

function generateSelfSignedCertificate() {
  mkdirSync(certDir, { recursive: true });

  if (!force && (existsSync(defaultCertPath) || existsSync(defaultKeyPath))) {
    process.stdout.write(
      `TLS certificate already exists at ${defaultCertPath}; skip generation (re-run with --force to overwrite).\n`
    );
    return;
  }

  const subjectAltName = /^\d+\.\d+\.\d+\.\d+$/.test(certHost)
    ? `subjectAltName=IP:${certHost}`
    : `subjectAltName=DNS:${certHost}`;

  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-keyout",
        defaultKeyPath,
        "-out",
        defaultCertPath,
        "-days",
        String(certDays),
        "-subj",
        `/CN=${certHost}`,
        "-addext",
        subjectAltName
      ],
      { stdio: "ignore" }
    );
  } catch {
    throw new Error(
      "Failed to generate TLS certificate. Ensure openssl is installed, or pass --skip-certs to only initialize env."
    );
  }

  chmodSync(defaultKeyPath, 0o600);
  chmodSync(defaultCertPath, 0o644);
  process.stdout.write(`Initialized TLS certificate: ${defaultCertPath} (CN/SAN=${certHost})\n`);
}

function getArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function randomToken(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function normalizeOptionalAbsoluteUrl(value) {
  if (!value) {
    return undefined;
  }
  return new URL(value).toString().replace(/\/$/, "");
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function deriveServerName(issuer) {
  return new URL(issuer).hostname;
}

function defaultDemoBaseUrlForProfile(profile) {
  if (profile === "test") {
    return "http://localhost:3002";
  }
  if (profile === "local") {
    return "https://localhost:3002";
  }
  return "https://demo.xxx.com";
}

function createClientSecretDigest(secret) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const keyLength = 32;
  const salt = randomBytes(16);
  const digest = scryptSync(secret, salt, keyLength, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024
  });
  return [
    "scrypt",
    `N=${N},r=${r},p=${p},keylen=${keyLength}`,
    salt.toString("base64url"),
    digest.toString("base64url")
  ].join("$");
}
