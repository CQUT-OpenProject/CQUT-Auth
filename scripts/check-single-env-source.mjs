import { globSync, readFileSync } from "node:fs";

const allowed = new Set([
  "src/app.ts",
  "src/config.ts",
  "src/scripts/seed-oidc-client.ts",
  "src/scripts/seed-oidc-signing-key.ts",
]);
const violations = globSync("src/**/*.ts")
  .map((file) => file.replaceAll("\\", "/"))
  .filter(
    (file) =>
      !allowed.has(file) && readFileSync(file, "utf8").includes("process.env"),
  );

if (violations.length > 0) {
  process.stderr.write(
    `Environment variables must be read through src/config.ts: ${violations.join(", ")}\n`,
  );
  process.exitCode = 1;
}
