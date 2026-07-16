import { readConfig } from "../config.js";
import { PersistenceRuntimeImpl } from "../persistence/persistence.js";
import { initializeOidcClientsFromConfig } from "../oidc/client-config.js";

async function main() {
  const config = readConfig(process.env);
  const store = new PersistenceRuntimeImpl(config);
  await store.init();
  const result = await initializeOidcClientsFromConfig(store, config);
  console.log(JSON.stringify(result));
  await store.close();
}

void main();
