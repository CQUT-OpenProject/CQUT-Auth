import { createDemoApp } from "./app.js";

async function bootstrap() {
  const port = Number(process.env["PORT"] ?? 3002);
  const app = await createDemoApp();
  app.listen(port, () => {
    console.log(`demo-site listening on http://localhost:${port}/demo`);
  });
}

void bootstrap();
