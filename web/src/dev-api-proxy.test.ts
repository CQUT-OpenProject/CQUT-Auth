import { expect, test } from "vite-plus/test";
import { resolveDevelopmentHost } from "../vite.config";

test("development server binds locally unless the container opts in", () => {
  expect(resolveDevelopmentHost({})).toBe("127.0.0.1");
  expect(resolveDevelopmentHost({ VITE_DEV_HOST: "0.0.0.0" })).toBe("0.0.0.0");
});
