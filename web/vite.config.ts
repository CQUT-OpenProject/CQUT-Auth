import { defineConfig } from "vite-plus";
import { resolve } from "node:path";

const localDevelopmentOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
]);
const developmentApiOrigin = "http://127.0.0.1:3003";

export function rewriteDevelopmentApiOrigin(origin: string) {
  return localDevelopmentOrigins.has(origin) ? developmentApiOrigin : origin;
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
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    watch: { usePolling: true },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3003",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            if (request.headers.origin) {
              proxyRequest.setHeader(
                "origin",
                rewriteDevelopmentApiOrigin(request.headers.origin),
              );
            }
          });
        },
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
