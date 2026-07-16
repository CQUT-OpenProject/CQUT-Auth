import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  mode: "test",
  test: {
    environment: "jsdom",
    env: { NODE_ENV: "development" },
    // The client-creation flow exercises several Ant Design modal transitions.
    // GitHub-hosted runners can exceed the default 15 seconds without a failure.
    testTimeout: 30_000,
  },
});
