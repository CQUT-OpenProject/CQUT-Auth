import { readOidcOpConfig } from "../config.js";
import { generateSigningKey } from "../oidc/provider.js";
import { OidcPersistenceImpl } from "../persistence/persistence.js";

async function main() {
  const config = readOidcOpConfig(process.env);
  const store = new OidcPersistenceImpl(config);
  await store.init();
  const key = await generateSigningKey(store);
  console.log(JSON.stringify({ kid: key.kid, status: key.status }));
  await store.close();
}

void main();
