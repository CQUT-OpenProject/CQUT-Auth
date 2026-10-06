import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { ClientRedirectUriCache } from "../src/oidc/client-redirect-uri-cache.js";

function deferredUris() {
  let resolve!: (value: string[]) => void;
  const promise = new Promise<string[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("CSP URI cache coalesces concurrent loads and reloads only after expiry", async () => {
  let now = 1000;
  const first = deferredUris();
  const load = vi
    .fn<() => Promise<string[]>>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(["https://new.example.com/callback"]);
  const cache = new ClientRedirectUriCache(
    { listActiveOidcClientRedirectUris: load },
    () => now,
  );
  const requests = Array.from({ length: 10 }, () => cache.get());
  assert.equal(load.mock.calls.length, 1);
  first.resolve(["https://old.example.com/callback"]);
  for (const uris of await Promise.all(requests)) {
    assert.deepEqual(uris, ["https://old.example.com/callback"]);
  }
  now = 5999;
  assert.deepEqual(await cache.get(), ["https://old.example.com/callback"]);
  assert.equal(load.mock.calls.length, 1);
  now = 6000;
  assert.deepEqual(await cache.get(), ["https://new.example.com/callback"]);
  assert.equal(load.mock.calls.length, 2);
});

test("CSP URI invalidation during a load never publishes stale client origins", async () => {
  const oldLoad = deferredUris();
  const load = vi
    .fn<() => Promise<string[]>>()
    .mockReturnValueOnce(oldLoad.promise)
    .mockResolvedValue(["https://new.example.com/callback"]);
  const cache = new ClientRedirectUriCache({
    listActiveOidcClientRedirectUris: load,
  });
  const oldRequest = cache.get();
  cache.invalidate();
  assert.deepEqual(await cache.get(), ["https://new.example.com/callback"]);
  oldLoad.resolve(["https://old.example.com/callback"]);
  assert.deepEqual(await oldRequest, ["https://new.example.com/callback"]);
  assert.deepEqual(await cache.get(), ["https://new.example.com/callback"]);
  assert.equal(load.mock.calls.length, 2);
});

test("CSP URI cache retries after a failed refresh", async () => {
  const load = vi
    .fn<() => Promise<string[]>>()
    .mockRejectedValueOnce(new Error("synthetic database failure"))
    .mockResolvedValue(["https://app.example.com/callback"]);
  const cache = new ClientRedirectUriCache({
    listActiveOidcClientRedirectUris: load,
  });
  await assert.rejects(cache.get(), /synthetic database failure/);
  assert.deepEqual(await cache.get(), ["https://app.example.com/callback"]);
  assert.equal(load.mock.calls.length, 2);
});
