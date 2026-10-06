import { test } from "vite-plus/test";
import {
  assert,
  createApp,
  login,
  request,
  seedAdmin,
} from "./management-api.helpers.js";

test("legacy email settings API has been removed", async () => {
  const { app, state } = await createApp();
  try {
    for (const path of [
      "/api/management/settings/email",
      "/api/management/settings/email/audit-logs",
      "/api/management/settings/email/test",
    ]) {
      assert.equal((await request(app).get(path)).status, 404);
    }
  } finally {
    await state.close();
  }
});

test("runtime policy restart is admin-only and runs after the response", async () => {
  let restartRequests = 0;
  const { app, state } = await createApp(
    {},
    {
      requestRestart: () => {
        restartRequests += 1;
      },
    },
  );
  await seedAdmin(state);
  try {
    const outsider = request.agent(app);
    const outsiderLogin = await login(outsider, "restart-outsider");
    const denied = await outsider
      .post("/api/management/settings/runtime-policy/restart")
      .set("X-CSRF-Token", outsiderLogin.body.csrfToken);
    assert.equal(denied.status, 403);
    assert.equal(restartRequests, 0);

    const admin = request.agent(app);
    const signedIn = await login(admin, "admin-account");
    const accepted = await admin
      .post("/api/management/settings/runtime-policy/restart")
      .set("X-CSRF-Token", signedIn.body.csrfToken);
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body, { restarting: true });
    assert.equal(restartRequests, 1);
  } finally {
    await state.close();
  }
});

test("liveness does not depend on dynamic client CSP lookup", async () => {
  const { app, state } = await createApp();
  state.persistence.clients.listActiveOidcClients = async () => {
    throw new Error("database unavailable");
  };
  try {
    assert.deepEqual((await request(app).get("/health/live")).body, {
      status: "live",
    });
  } finally {
    await state.close();
  }
});
