import { defineConfig } from "vite-plus";
import { resolve } from "node:path";

export function resolveDevelopmentHost(env: NodeJS.ProcessEnv) {
  return env["VITE_DEV_HOST"] ?? "127.0.0.1";
}

export default defineConfig({
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
  },
  root: resolve(import.meta.dirname),
  base: "/manage/",
  publicDir: resolve(import.meta.dirname, "public"),
  server: {
    host: resolveDevelopmentHost(process.env),
    port: 5173,
    strictPort: true,
    watch: { usePolling: true },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3003",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "../dist/management"),
    emptyOutDir: true,
    rolldownOptions: {
      checks: { moduleLevelDirective: false },
    },
  },
});
