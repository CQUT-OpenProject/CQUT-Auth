import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

export function getClientHtmlPaths(projectRoot) {
  return {
    source: resolve(projectRoot, "src/client/index.html"),
    output: resolve(projectRoot, "public/index.html")
  };
}

export async function copyClientHtml(projectRoot) {
  const { source, output } = getClientHtmlPaths(projectRoot);
  await copyFile(source, output);
}

export function getClientBuildOptions(projectRoot, overrides = {}) {
  return {
    entryPoints: {
      app: resolve(projectRoot, "src/client/main.ts"),
      style: resolve(projectRoot, "src/client/style.css")
    },
    outdir: resolve(projectRoot, "public/assets"),
    entryNames: "[name]",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    logLevel: "info",
    ...overrides
  };
}
