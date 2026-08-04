import { readConfig } from "../config.js";
import { generateSigningKey } from "../oidc/provider.js";
import { createPersistence } from "../persistence/persistence.js";

async function main() {
  const config = readConfig(process.env);
  const persistence = await createPersistence(config);
  const existing = await persistence.signingKeys.listSigningKeys(["active"]);
  if (existing.length > 0) {
    console.log(
      JSON.stringify({
        skipped: true,
        existingActiveKeys: existing.length,
        hint: "an active signing key already exists; to rotate, create a new key then retire old ones",
      }),
    );
    await persistence.runtime.close();
    return;
  }
  const key = await generateSigningKey(persistence);
  console.log(JSON.stringify({ kid: key.kid, status: key.status }));
  await persistence.runtime.close();
}

void main();
