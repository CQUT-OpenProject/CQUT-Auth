import { readOidcOpConfig } from "../config.js";
import { OidcPersistenceImpl } from "../persistence/persistence.js";
import { seedDemoClient } from "../oidc/provider.js";

async function main() {
  const config = readOidcOpConfig(process.env);
  const store = new OidcPersistenceImpl(config);
  await store.init();
  await seedDemoClient(store, config);
  await store.close();
}

void main();
