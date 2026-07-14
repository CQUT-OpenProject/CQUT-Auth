import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  mode: "test",
  test: {
    environment: "jsdom",
    env: { NODE_ENV: "development" },
  },
});
