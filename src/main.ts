import { createOidcApp } from "./app.js";

async function bootstrap() {
  const { app, state } = await createOidcApp(undefined, {
    requestRestart: () => process.kill(process.pid, "SIGTERM"),
  });
  console.warn(
    "[oidc-op] Managed OIDC profile active: only controlled, allowlisted clients are supported; this deployment is not a general-purpose open ecosystem OP.",
  );
  if (state.config.smallDeployment && !state.config.redisUrl) {
    console.warn(
      "[oidc-op] Small deployment mode: rate limiting uses in-process memory (single instance only; counters reset on restart).",
    );
  }
  const server = app.listen(state.config.port);
  process.on("SIGINT", async () => {
    server.close();
    await state.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    server.close();
    await state.close();
    process.exit(0);
  });
}

void bootstrap();
