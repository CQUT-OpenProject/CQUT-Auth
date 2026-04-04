import { readOidcOpConfig } from "../config.js";
import { OidcStore } from "../persistence/store.js";
import { seedDemoClient } from "../oidc/provider.js";

async function main() {
  const config = readOidcOpConfig(process.env);
  const store = new OidcStore(config);
  await store.init();
  await seedDemoClient(store, config);
  await store.close();
}

void main();
