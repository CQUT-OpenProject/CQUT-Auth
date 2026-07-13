import { readOidcOpConfig } from "../config.js";
import { OidcPersistenceImpl } from "../persistence/persistence.js";
import { upsertOidcClientsFromConfig } from "../oidc/client-config.js";

async function main() {
  const config = readOidcOpConfig(process.env);
  const store = new OidcPersistenceImpl(config);
  await store.init();
  const clients = await upsertOidcClientsFromConfig(store, config);
  console.log(JSON.stringify({ upsertedClients: clients.map((item) => item.clientId) }));
  await store.close();
}

void main();
