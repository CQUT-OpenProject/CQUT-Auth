import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(projectRoot, "deploy/.env.example");
const defaultOutputPath = resolve(projectRoot, "deploy/.env");
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

if (!allowedProfiles.has(profile)) {
  throw new Error("--profile must be one of: production, local, test");
}
if (skipCerts && withCerts) {
  throw new Error("--skip-certs and --with-certs cannot be used together");
}

const certHostDefault = profile === "test" ? "localhost" : "verify.local";
const certHost = getArgValue("--cert-host") ?? certHostDefault;
const certDays = Number(getArgValue("--cert-days") ?? "365");
if (!Number.isInteger(certDays) || certDays <= 0) {
  throw new Error("--cert-days must be a positive integer");
}

const randomReplacements = {
  POSTGRES_PASSWORD: randomToken(24),
  OIDC_KEY_ENCRYPTION_SECRET: randomToken(32),
  OIDC_ARTIFACT_ENCRYPTION_SECRET: randomToken(32),
  OIDC_COOKIE_KEYS: `${randomToken(32)},${randomToken(32)}`,
  OIDC_CSRF_SIGNING_SECRET: randomToken(32),
  OIDC_DEMO_CLIENT_SECRET: randomToken(24)
};

const profileReplacements = {
  production: {},
  local: {
    APP_ENV: "development",
    OIDC_ISSUER: "https://verify.local",
    OIDC_COOKIE_SECURE: "true",
    OIDC_DEMO_REDIRECT_URI: "https://localhost:3002/demo/callback",
    OIDC_DEMO_POST_LOGOUT_REDIRECT_URI: "https://localhost:3002/demo/logout-complete",
    SERVER_NAME: "verify.local"
  },
  test: {
    APP_ENV: "test",
    OIDC_ISSUER: "http://localhost",
    OIDC_COOKIE_SECURE: "false",
    OIDC_DEMO_REDIRECT_URI: "http://localhost:3002/demo/callback",
    OIDC_DEMO_POST_LOGOUT_REDIRECT_URI: "http://localhost:3002/demo/logout-complete",
    SERVER_NAME: "localhost"
  }
};

const replacements = {
  ...randomReplacements,
  ...profileReplacements[profile]
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
