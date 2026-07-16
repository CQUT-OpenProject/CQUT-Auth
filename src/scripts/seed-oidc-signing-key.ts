import { readConfig } from "../config.js";
import { generateSigningKey } from "../oidc/provider.js";
import { createPersistence } from "../persistence/persistence.js";

async function main() {
  const config = readConfig(process.env);
  const persistence = await createPersistence(config);
  const key = await generateSigningKey(persistence);
  console.log(JSON.stringify({ kid: key.kid, status: key.status }));
  await persistence.runtime.close();
}

void main();
