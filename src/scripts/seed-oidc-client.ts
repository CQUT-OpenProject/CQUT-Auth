import { readConfig } from "../config.js";
import { createPersistence } from "../persistence/persistence.js";
import { initializeOidcClientsFromConfig } from "../oidc/client-config.js";

async function main() {
  const config = readConfig(process.env);
  const persistence = await createPersistence(config);
  const result = await initializeOidcClientsFromConfig(
    persistence.clients,
    config,
  );
  console.log(JSON.stringify(result));
  await persistence.runtime.close();
}

void main();
