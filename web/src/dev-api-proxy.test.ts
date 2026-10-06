import { expect, test } from "vite-plus/test";
import { rewriteDevelopmentApiOrigin } from "../vite.config";

test("rewrites only local Vite origins to the development API origin", () => {
  expect(rewriteDevelopmentApiOrigin("http://127.0.0.1:5173")).toBe(
    "http://127.0.0.1:3003",
  );
  expect(rewriteDevelopmentApiOrigin("http://localhost:5173")).toBe(
    "http://127.0.0.1:3003",
  );
  expect(rewriteDevelopmentApiOrigin("https://attacker.example")).toBe(
    "https://attacker.example",
  );
});
