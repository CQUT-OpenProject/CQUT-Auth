import { createDemoApp } from "./app.js";

const port = Number(process.env["PORT"] ?? 3002);
const app = createDemoApp();

app.listen(port, () => {
  console.log(`demo-site listening on http://localhost:${port}/demo`);
});
