import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOidcOpConfig } from "../src/config.js";
import { createClientSecretDigest } from "../src/crypto.js";
import { upsertOidcClientsFromConfig, loadOidcClientsFromConfig } from "../src/oidc/client-config.js";
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
        postLogoutRedirectUris: ["http://localhost:3002/logout"]
      }
    ]
  });
  const clients = await loadOidcClientsFromConfig({
    appEnv: "test",
    oidcClientsConfigPath: filePath
  });
  assert.equal(clients.length, 1);
  assert.equal(clients[0]?.clientId, "site-a");
  assert.equal(clients[0]?.tokenEndpointAuthMethod, "client_secret_basic");
  assert.deepEqual(clients[0]?.grantTypes, ["authorization_code", "refresh_token"]);
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
        postLogoutRedirectUris: ["http://localhost:3002/logout"]
      }
    ]
  });
  const clients = await loadOidcClientsFromConfig({
    appEnv: "test",
    oidcClientsConfigPath: filePath
  });
  assert.equal(clients.length, 1);
  assert.equal(clients[0]?.tokenEndpointAuthMethod, "none");
  assert.deepEqual(clients[0]?.grantTypes, ["authorization_code"]);
  assert.deepEqual(clients[0]?.scopeWhitelist, ["openid", "profile"]);
  assert.equal(clients[0]?.allowRefreshTokenForPublicClient, false);
});

test("loadOidcClientsFromConfig rejects public refresh_token without explicit confirmation", async () => {
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "public-site",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/logout"],
        grantTypes: ["authorization_code", "refresh_token"],
        scopeWhitelist: ["openid", "profile", "offline_access"]
      }
    ]
  });
  await assert.rejects(
    () =>
      loadOidcClientsFromConfig({
        appEnv: "test",
        oidcClientsConfigPath: filePath
      }),
    /allowRefreshTokenForPublicClient=true is required/
  );
});

test("loadOidcClientsFromConfig accepts explicitly confirmed public refresh_token", async () => {
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "public-site",
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/logout"],
        grantTypes: ["authorization_code", "refresh_token"],
        scopeWhitelist: ["openid", "profile", "offline_access"],
        allowRefreshTokenForPublicClient: true
      }
    ]
  });
  const clients = await loadOidcClientsFromConfig({
    appEnv: "test",
    oidcClientsConfigPath: filePath
  });
  assert.equal(clients[0]?.allowRefreshTokenForPublicClient, true);
  assert.deepEqual(clients[0]?.grantTypes, ["authorization_code", "refresh_token"]);
  assert.deepEqual(clients[0]?.scopeWhitelist, ["openid", "profile", "offline_access"]);
});

test("loadOidcClientsFromConfig fails on missing config file", async () => {
  await assert.rejects(
    () =>
      loadOidcClientsFromConfig({
        appEnv: "test",
        oidcClientsConfigPath: "/tmp/non-existent-oidc-clients.json"
      }),
    /failed to read OIDC clients config/
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
        postLogoutRedirectUris: ["http://localhost:3002/logout"]
      },
      {
        clientId: "site-a",
        clientSecretDigest: digest,
        redirectUris: ["http://localhost:3003/callback"],
        postLogoutRedirectUris: ["http://localhost:3003/logout"]
      }
    ]
  });
  await assert.rejects(
    () =>
      loadOidcClientsFromConfig({
        appEnv: "test",
        oidcClientsConfigPath: filePath
      }),
    /duplicate oidc client clientId/
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
        postLogoutRedirectUris: ["https://site-a.example.com/logout"]
      }
    ]
  });
  await assert.rejects(
    () =>
      loadOidcClientsFromConfig({
        appEnv: "production",
        oidcClientsConfigPath: filePath
      }),
    /redirectUris must use https:\/\//
  );
});

test("upsertOidcClientsFromConfig inserts configured client records", async () => {
  const digest = await createClientSecretDigest("test-client-secret");
  const filePath = await writeClientsConfig({
    clients: [
      {
        clientId: "site-a",
        clientSecretDigest: digest,
        redirectUris: ["http://localhost:3002/callback"],
        postLogoutRedirectUris: ["http://localhost:3002/logout"]
      }
    ]
  });
  const config = readOidcOpConfig({
    APP_ENV: "test",
    OIDC_KEY_ENCRYPTION_SECRET: "test-oidc-key-secret",
    OIDC_ARTIFACT_ENCRYPTION_SECRET: "test-oidc-artifact-secret",
    OIDC_CLIENTS_CONFIG_PATH: filePath,
    OIDC_ARTIFACT_CLEANUP_ENABLED: "true"
  });
  const store = new OidcPersistenceImpl(config);
  await store.init();
  await upsertOidcClientsFromConfig(store, config);
  const activeClients = await store.listActiveOidcClients();
  assert.equal(activeClients.length, 1);
  assert.equal(activeClients[0]?.clientId, "site-a");
  assert.equal(activeClients[0]?.allowRefreshTokenForPublicClient, false);
  await store.close();
});
