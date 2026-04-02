import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(projectRoot, "deploy/.env.example");
const defaultOutputPath = resolve(projectRoot, "deploy/.env");

const args = process.argv.slice(2);
const outputPath = getArgValue("--write");
const force = args.includes("--force");
const printToStdout = args.includes("--stdout");

const replacements = {
  POSTGRES_PASSWORD: randomToken(24),
  DEDUPE_KEY_SECRET: randomToken(32),
  JOB_PAYLOAD_SECRET: randomToken(32),
  CLIENT_SECRET: randomToken(32)
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

function writeOutput(targetPath) {
  if (existsSync(targetPath) && !force) {
    throw new Error(`Refusing to overwrite existing file: ${targetPath}. Re-run with --force if needed.`);
  }

  writeFileSync(targetPath, `${rendered}\n`, { encoding: "utf8" });
  process.stdout.write(`Generated deploy env file: ${targetPath}\n`);
}

function getArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a file path value`);
  }
  return value;
}

function randomToken(bytes) {
  return randomBytes(bytes).toString("base64url");
}
