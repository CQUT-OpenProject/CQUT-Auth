import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "/manage/",
  build: {
    outDir: resolve(import.meta.dirname, "../dist/management"),
    emptyOutDir: true,
  },
});
