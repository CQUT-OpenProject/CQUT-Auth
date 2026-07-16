import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { decorateClientFinder } from "../src/oidc/provider-internals.adapter.js";

test("oidc private adapter contract targets oidc-provider v9", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../node_modules/oidc-provider/package.json", import.meta.url),
      "utf8",
    ),
  ) as { version: string };
  assert.match(manifest.version, /^9\./);
});

test("oidc private adapter decorates dynamically loaded clients", async () => {
  const client = { clientId: "client-1" };
  const provider = {
    Client: {
      find: async (id: string) => (id === client.clientId ? client : undefined),
    },
  };
  decorateClientFinder(provider, (loaded) => {
    loaded.decorated = true;
  });
  assert.deepEqual(await provider.Client.find("client-1"), {
    clientId: "client-1",
    decorated: true,
  });
});
