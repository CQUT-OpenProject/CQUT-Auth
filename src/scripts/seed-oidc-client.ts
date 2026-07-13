import { readOidcOpConfig } from "../config.js";
import { OidcPersistenceImpl } from "../persistence/persistence.js";
import { initializeOidcClientsFromConfig } from "../oidc/client-config.js";

async function main() {
  const config = readOidcOpConfig(process.env);
  const store = new OidcPersistenceImpl(config);
  await store.init();
  const result = await initializeOidcClientsFromConfig(store, config);
  console.log(JSON.stringify(result));
  await store.close();
}

void main();
