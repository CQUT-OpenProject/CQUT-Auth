import { createOidcApp } from "./app.js";

async function bootstrap() {
  const { app, state } = await createOidcApp(undefined, {
    requestRestart: () => process.kill(process.pid, "SIGTERM"),
  });
  console.warn(
    "[oidc-op] Managed OIDC profile active: only controlled, allowlisted clients are supported; this deployment is not a general-purpose open ecosystem OP.",
  );
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
