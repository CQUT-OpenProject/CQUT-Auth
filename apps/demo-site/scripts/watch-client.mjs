import { watch } from "node:fs";
import { context } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyClientHtml, getClientBuildOptions, getClientHtmlPaths } from "./client-build.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

await copyClientHtml(projectRoot);
const ctx = await context(getClientBuildOptions(projectRoot));
await ctx.watch();
console.log("[client] watching src/client -> public");

const htmlPaths = getClientHtmlPaths(projectRoot);
const htmlWatcher = watch(htmlPaths.source, () => {
  void copyClientHtml(projectRoot).then(() => {
    console.log("[client] copied index.html");
  });
});

const shutdown = async () => {
  htmlWatcher.close();
  await ctx.dispose();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

await new Promise(() => {});
