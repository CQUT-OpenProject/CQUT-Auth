import { createOidcApp } from "./app.js";

async function bootstrap() {
  const { app, state } = await createOidcApp();
  const server = app.listen(state.config.port);
  process.on("SIGINT", async () => {
    server.close();
    await state.rateLimitService.close();
    await state.store.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    server.close();
    await state.rateLimitService.close();
    await state.store.close();
    process.exit(0);
  });
}

void bootstrap();
