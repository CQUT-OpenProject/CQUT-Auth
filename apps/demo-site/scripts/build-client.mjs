import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const publicAssetsDir = resolve(rootDir, "public/assets");

await mkdir(publicAssetsDir, { recursive: true });

await build({
  entryPoints: [resolve(rootDir, "src/client/main.tsx")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  outfile: resolve(publicAssetsDir, "app.js"),
  define: {
    "process.env.NODE_ENV": '"production"'
  },
  loader: {
    ".css": "css"
  }
});
