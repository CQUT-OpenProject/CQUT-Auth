import { defineConfig } from "vite-plus";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "/manage/",
  publicDir: resolve(import.meta.dirname, "public"),
  build: {
    outDir: resolve(import.meta.dirname, "../dist/management"),
    emptyOutDir: true,
    rolldownOptions: {
      checks: { moduleLevelDirective: false },
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:react|react-dom|react-router|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: "antd-vendor",
              test: /node_modules[\\/]antd[\\/]/,
              includeDependenciesRecursively: false,
              maxSize: 350_000,
              priority: 25,
            },
            {
              name: "antd-support",
              test: /node_modules[\\/]@ant-design[\\/]/,
              priority: 24,
            },
            {
              name: "rc-vendor",
              test: /node_modules[\\/](?:@rc-component|rc-[^\\/]+)[\\/]/,
              priority: 23,
            },
            {
              name: "refine-vendor",
              test: /node_modules[\\/](?:@refinedev|@tanstack)[\\/]/,
              priority: 15,
            },
            {
              name: "vendor",
              test: /node_modules/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
