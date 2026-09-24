import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "web",
          root: "./web",
          environment: "jsdom",
          env: { NODE_ENV: "development" },
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          testTimeout: 30_000,
        },
      },
    ],
  },
  fmt: {
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "all",
    printWidth: 80,
    sortPackageJson: false,
    ignorePatterns: [
      "node_modules/",
      "dist/",
      "coverage/",
      "docs/.vitepress/",
      "pnpm-lock.yaml",
    ],
  },
  lint: {
    plugins: ["typescript"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "typescript/no-base-to-string": "off",
    },
    overrides: [
      {
        files: ["web/**/*.{ts,tsx}"],
        plugins: ["react", "jsx-a11y"],
        rules: {
          "react-hooks/exhaustive-deps": "off",
          "react/purity": "off",
          "react/set-state-in-effect": "off",
        },
      },
      {
        files: ["**/*.test.{ts,tsx}"],
        plugins: ["vitest"],
        rules: {
          "vitest/expect-expect": "off",
          "vitest/no-disabled-tests": "off",
          "vitest/require-mock-type-parameters": "off",
          "vitest/valid-title": "off",
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  staged: {
    "*.{js,mjs,cjs,ts,tsx}": "vp check --fix",
    "*.{json,md,css,yml,yaml}": "vp fmt",
  },
});
