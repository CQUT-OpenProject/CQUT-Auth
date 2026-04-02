import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyClientHtml, getClientBuildOptions } from "./client-build.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

await copyClientHtml(projectRoot);
await build(getClientBuildOptions(projectRoot));
