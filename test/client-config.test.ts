import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOidcOpConfig } from "../src/config.js";
import { createClientSecretDigest } from "../src/crypto.js";
import {
  initializeOidcClientsFromConfig,
  loadOidcClientsFromConfig,
} from "../src/oidc/client-config.js";
import { OidcPersistenceImpl } from "../src/persistence/persistence.js";

async function writeClientsConfig(document: object) {
  const directory = mkdtempSync(join(tmpdir(), "oidc-client-config-"));
  const filePath = join(directory, "oidc-clients.json");
  writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return filePath;
}

test("loadOidcClientsFromConfig applies defaults for minimal client config", async () => {
  const digest = await createClientSecretDigest("test-client-secret");
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "site-a",
        clientSecretDigest: digest,
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/logout"],
      },
    ],
  });
  const clients = await loadOidcClientsFromConfig({
    appEnv: "test",
    oidcClientsConfigPath: filePath,
  });
  assert.equal(clients.length, 1);
  assert.equal(clients[0]?.clientId, "site-a");
  assert.equal(clients[0]?.tokenEndpointAuthMethod, "client_secret_basic");
  assert.deepEqual(clients[0]?.grantTypes, [
    "authorization_code",
    "refresh_token",
  ]);
  assert.deepEqual(clients[0]?.scopeWhitelist, ["openid", "profile"]);
  assert.deepEqual(clients[0]?.responseTypes, ["code"]);
  assert.equal(clients[0]?.requirePkce, true);
  assert.equal(clients[0]?.allowRefreshTokenForPublicClient, false);
  assert.equal(clients[0]?.autoConsent, false);
  assert.equal(clients[0]?.status, "active");
});

test("loadOidcClientsFromConfig applies safer defaults for public client config", async () => {
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "public-site",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/logout"],
      },
    ],
  });
  const clients = await loadOidcClientsFromConfig({
    appEnv: "test",
    oidcClientsConfigPath: filePath,
  });
  assert.equal(clients.length, 1);
  assert.equal(clients[0]?.tokenEndpointAuthMethod, "none");
  assert.deepEqual(clients[0]?.grantTypes, ["authorization_code"]);
  assert.deepEqual(clients[0]?.scopeWhitelist, ["openid", "profile"]);
  assert.equal(clients[0]?.allowRefreshTokenForPublicClient, false);
});

test("loadOidcClientsFromConfig rejects refresh tokens for SPA clients", async () => {
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "public-site",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/logout"],
        grantTypes: ["authorization_code", "refresh_token"],
        scopeWhitelist: ["openid", "profile", "offline_access"],
      },
    ],
  });
  await assert.rejects(
    () =>
      loadOidcClientsFromConfig({
        appEnv: "test",
        oidcClientsConfigPath: filePath,
      }),
    /SPA clients cannot request offline_access/,
  );
});

test("loadOidcClientsFromConfig rejects SPA refresh tokens even when legacy confirmation is present", async () => {
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "public-site",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/logout"],
        grantTypes: ["authorization_code", "refresh_token"],
        scopeWhitelist: ["openid", "profile", "offline_access"],
        allowRefreshTokenForPublicClient: true,
      },
    ],
  });
  await assert.rejects(
    () =>
      loadOidcClientsFromConfig({
        appEnv: "test",
        oidcClientsConfigPath: filePath,
      }),
    /SPA clients cannot request offline_access/,
  );
});

test("loadOidcClientsFromConfig allows missing or empty bootstrap config", async () => {
  assert.deepEqual(
    await loadOidcClientsFromConfig({
      appEnv: "test",
      oidcClientsConfigPath: "/tmp/non-existent-oidc-clients.json",
    }),
    [],
  );
  const filePath = await writeClientsConfig({ clients: [] });
  assert.deepEqual(
    await loadOidcClientsFromConfig({
      appEnv: "test",
      oidcClientsConfigPath: filePath,
    }),
    [],
  );
});

test("loadOidcClientsFromConfig requires the openid scope", async () => {
  const digest = await createClientSecretDigest("test-client-secret");
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "site-without-openid",
        clientSecretDigest: digest,
        redirectUris: ["http://localhost:3002/callback"],
        scopeWhitelist: ["profile"],
      },
    ],
  });
  await assert.rejects(
    () =>
      loadOidcClientsFromConfig({
        appEnv: "test",
        oidcClientsConfigPath: filePath,
      }),
    /scopeWhitelist must include openid/,
  );
});

test("loadOidcClientsFromConfig rejects duplicate clientId", async () => {
  const digest = await createClientSecretDigest("test-client-secret");
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "site-a",
        clientSecretDigest: digest,
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/logout"],
      },
      {
        clientId: "site-a",
        clientSecretDigest: digest,
        redirectUris: ["http://localhost:3003/callback"],
        postLogoutRedirectUris: ["http://localhost:3003/logout"],
      },
    ],
  });
  await assert.rejects(
    () =>
      loadOidcClientsFromConfig({
        appEnv: "test",
        oidcClientsConfigPath: filePath,
      }),
    /duplicate oidc client clientId/,
  );
});

test("loadOidcClientsFromConfig rejects non-https redirect outside test", async () => {
  const digest = await createClientSecretDigest("test-client-secret");
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "site-a",
        clientSecretDigest: digest,
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["https://site-a.example.com/logout"],
      },
    ],
  });
  await assert.rejects(
    () =>
      loadOidcClientsFromConfig({
        appEnv: "production",
        oidcClientsConfigPath: filePath,
      }),
    /redirectUris must use https:\/\//,
  );
});

test("initializeOidcClientsFromConfig inserts configured client records", async () => {
  const digest = await createClientSecretDigest("test-client-secret");
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "site-a",
        clientSecretDigest: digest,
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/logout"],
      },
    ],
  });
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_CLIENTS_CONFIG_PATH: filePath,
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true",
  });
  const store = new OidcPersistenceImpl(config);
  await store.init();
  await initializeOidcClientsFromConfig(store, config);
  const activeClients = await store.listActiveOidcClients();
  assert.equal(activeClients.length, 1);
  assert.equal(activeClients[0]?.clientId, "site-a");
  assert.equal(activeClients[0]?.allowRefreshTokenForPublicClient, false);
  await store.close();
});

test("client config initialization skips file access and never overwrites a non-empty store", async () => {
  const digest = await createClientSecretDigest("test-client-secret");
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "site-a",
        clientSecretDigest: digest,
        displayName: "Original name",
        redirectUris: ["http://localhost:3002/callback"],
      },
    ],
  });
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_CLIENTS_CONFIG_PATH: filePath,
  });
  const store = new OidcPersistenceImpl(config);
  await store.init();
  const first = await initializeOidcClientsFromConfig(store, config);
  assert.deepEqual(first, { imported: true, count: 1 });

  const skipped = await initializeOidcClientsFromConfig(store, {
    appEnv: "test",
    oidcClientsConfigPath: "/definitely/missing/clients.json",
  });
  assert.deepEqual(skipped, { imported: false, count: 0 });
  assert.equal(
    (await store.findOidcClient("site-a"))?.displayName,
    "Original name",
  );
  await store.close();
});
