import { test } from "vite-plus/test";
import {
  FakeEmailSender,
  FlakyEmailSender,
  RateLimitUnavailableError,
  assert,
  createTestApp,
  extractCsrf,
  request,
  sendEmailVerificationCode,
  startEmailVerification,
} from "./oidc-op.helpers.js";

test("email verification save failure does not send email and rolls back rate limit", async () => {
  const emailSender = new FakeEmailSender();
  const { app, state } = await createTestApp(
    {
      OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "1",
    },
    { emailSender },
  );
  const originalSave = state.persistence.artifacts.saveInteractionLogin.bind(
    state.persistence.artifacts,
  );
  let failSave = true;
  state.persistence.artifacts.saveInteractionLogin = async (uid, value) => {
    if (failSave && value.emailVerification) {
      throw new Error("persistence unavailable");
    }
    return originalSave(uid, value);
  };
  const agent = request.agent(app);
  try {
    const first = await sendEmailVerificationCode(
      agent,
      "email-verify-save-failure-first",
      "save-fail@example.com",
    );
    assert.equal(first.sendCode.status, 500);
    assert.equal(emailSender.sentVerifications.length, 0);

    failSave = false;
    const second = await sendEmailVerificationCode(
      agent,
      "email-verify-save-failure-second",
      "save-fail@example.com",
    );
    assert.equal(second.sendCode.status, 200);
    assert.equal(emailSender.sentVerifications.length, 1);
  } finally {
    state.persistence.artifacts.saveInteractionLogin = originalSave;
    await state.persistence.runtime.close();
  }
});

test("profile verify keeps pending login when oidc finish fails", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);
  const { profileLocation, interactionUid, code, sendCode } =
    await startEmailVerification(agent, emailSender, "profile-finish-failure");
  await state.persistence.artifacts.destroyArtifact(
    `Interaction:${interactionUid}`,
  );
  const verify = await agent
    .post(profileLocation)
    .type("form")
    .send({
      csrf: extractCsrf(sendCode.text),
      action: "verify_code",
      code,
    });
  assert.equal(verify.status, 400);
  assert.match(verify.text, /登录流程已过期/);
  assert.ok(
    await state.persistence.artifacts.getInteractionLogin(interactionUid),
  );
  await state.persistence.runtime.close();
});

test("email verification rejects wrong code after max attempts", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);
  const { profileLocation, sendCode } = await startEmailVerification(
    agent,
    emailSender,
    "email-verify-wrong-code",
  );

  let csrf = extractCsrf(sendCode.text);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const verify = await agent.post(profileLocation).type("form").send({
      csrf,
      action: "verify_code",
      code: "000000",
    });
    assert.equal(verify.status, 400);
    if (attempt < 5) {
      assert.match(verify.text, /验证码错误，还可尝试/);
      csrf = extractCsrf(verify.text);
      continue;
    }
    assert.match(verify.text, /验证码尝试次数过多，请重新发送/);
  }

  await state.persistence.runtime.close();
});

test("email verification expires and requires resending code", async () => {
  const { app, state, emailSender } = await createTestApp({
    OIDC_EMAIL_VERIFY_CODE_TTL_SECONDS: "1",
  });
  const agent = request.agent(app);
  const { profileLocation, code, sendCode } = await startEmailVerification(
    agent,
    emailSender,
    "email-verify-expired",
  );
  const verifyCsrf = extractCsrf(sendCode.text);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const verify = await agent.post(profileLocation).type("form").send({
    csrf: verifyCsrf,
    action: "verify_code",
    code,
  });
  assert.equal(verify.status, 400);
  assert.match(verify.text, /验证码已过期，请重新发送/);
  await state.persistence.runtime.close();
});

test("email verification resend is blocked during cooldown window", async () => {
  const { app, state, emailSender } = await createTestApp();
  const agent = request.agent(app);
  const { profileLocation, sendCode } = await startEmailVerification(
    agent,
    emailSender,
    "email-verify-cooldown",
  );
  const resendCsrf = extractCsrf(sendCode.text);
  const resend = await agent.post(profileLocation).type("form").send({
    csrf: resendCsrf,
    action: "send_code",
    email: "demo@example.com",
  });
  assert.equal(resend.status, 429);
  assert.match(resend.text, /秒后再重试发送/);
  await state.persistence.runtime.close();
});

test("email verification global rate limit blocks by subjectId across interactions", async () => {
  const { app, state, emailSender } = await createTestApp({
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "10",
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(
    agent,
    "email-verify-subject-limit-first",
    "first@alpha.example.com",
  );
  assert.equal(first.sendCode.status, 200);
  assert.equal(emailSender.sentVerifications.length, 1);

  const second = await sendEmailVerificationCode(
    agent,
    "email-verify-subject-limit-second",
    "second@beta.example.com",
  );
  assert.equal(second.sendCode.status, 429);
  assert.equal(second.sendCode.headers["retry-after"], "600");
  assert.match(second.sendCode.text, /发送过于频繁/);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.persistence.runtime.close();
});

test("email verification global rate limit blocks by target email across interactions", async () => {
  const { app, state, emailSender } = await createTestApp({
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "10",
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(
    agent,
    "email-verify-email-limit-first",
    "victim@example.com",
  );
  assert.equal(first.sendCode.status, 200);
  assert.equal(emailSender.sentVerifications.length, 1);

  const second = await sendEmailVerificationCode(
    agent,
    "email-verify-email-limit-second",
    "victim@example.com",
  );
  assert.equal(second.sendCode.status, 429);
  assert.equal(second.sendCode.headers["retry-after"], "600");
  assert.match(second.sendCode.text, /发送过于频繁/);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.persistence.runtime.close();
});

test("email verification global rate limit blocks by target domain across interactions", async () => {
  const { app, state, emailSender } = await createTestApp({
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "10",
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(
    agent,
    "email-verify-domain-limit-first",
    "first@target.example.com",
  );
  assert.equal(first.sendCode.status, 200);
  assert.equal(emailSender.sentVerifications.length, 1);

  const second = await sendEmailVerificationCode(
    agent,
    "email-verify-domain-limit-second",
    "second@target.example.com",
  );
  assert.equal(second.sendCode.status, 429);
  assert.equal(second.sendCode.headers["retry-after"], "600");
  assert.match(second.sendCode.text, /发送过于频繁/);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.persistence.runtime.close();
});

test("email verification global rate limit blocks by source ip across interactions", async () => {
  const { app, state, emailSender } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "1",
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(
    agent,
    "email-verify-ip-limit-first",
    "first@ip-a.example.com",
    { "X-Forwarded-For": "198.51.100.40" },
  );
  assert.equal(first.sendCode.status, 200);
  assert.equal(emailSender.sentVerifications.length, 1);

  const second = await sendEmailVerificationCode(
    agent,
    "email-verify-ip-limit-second",
    "second@ip-b.example.com",
    { "X-Forwarded-For": "198.51.100.40" },
  );
  assert.equal(second.sendCode.status, 429);
  assert.equal(second.sendCode.headers["retry-after"], "600");
  assert.match(second.sendCode.text, /发送过于频繁/);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.persistence.runtime.close();
});

test("email verification trusted proxy resolution ignores spoofed leading forwarded ips", async () => {
  const { app, state, emailSender } = await createTestApp({
    TRUST_PROXY_HOPS: "1",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "1",
  });
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(
    agent,
    "email-verify-spoofed-xff-first",
    "first@spoofed.example.com",
    { "X-Forwarded-For": "203.0.113.1, 198.51.100.50" },
  );
  const second = await sendEmailVerificationCode(
    agent,
    "email-verify-spoofed-xff-second",
    "second@spoofed.example.com",
    { "X-Forwarded-For": "203.0.113.99, 198.51.100.50" },
  );

  assert.equal(first.sendCode.status, 200);
  assert.equal(second.sendCode.status, 429);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.persistence.runtime.close();
});

test("email verification send failure rolls back consumed rate-limit budget", async () => {
  const emailSender = new FlakyEmailSender();
  const { app, state } = await createTestApp(
    {
      OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
      OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
      OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
      OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "1",
    },
    { emailSender },
  );
  const agent = request.agent(app);
  const first = await sendEmailVerificationCode(
    agent,
    "email-verify-send-failure-first",
    "retry@example.com",
  );
  assert.equal(first.sendCode.status, 503);

  emailSender.shouldFail = false;
  const second = await sendEmailVerificationCode(
    agent,
    "email-verify-send-failure-second",
    "retry@example.com",
  );
  assert.equal(second.sendCode.status, 200);
  assert.equal(emailSender.sentVerifications.length, 1);
  await state.persistence.runtime.close();
});

test("email verification rate limit outage rolls back partially consumed budget", async () => {
  const { app, state } = await createTestApp({
    OIDC_EMAIL_VERIFY_RATE_LIMIT_SUBJECT_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_EMAIL_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_DOMAIN_MAX: "10",
    OIDC_EMAIL_VERIFY_RATE_LIMIT_IP_MAX: "10",
  });
  const originalConsume = state.rateLimitService.consume.bind(
    state.rateLimitService,
  );
  let failEmailVerifyConsume = false;
  state.rateLimitService.consume = async (key, max, windowSeconds) => {
    if (failEmailVerifyConsume && key.includes(":email-verify:email:")) {
      throw new RateLimitUnavailableError();
    }
    return originalConsume(key, max, windowSeconds);
  };
  const agent = request.agent(app);
  try {
    failEmailVerifyConsume = true;
    const first = await sendEmailVerificationCode(
      agent,
      "email-verify-rate-limit-outage-first",
      "partial-rollback@example.com",
    );
    assert.equal(first.sendCode.status, 503);
    assert.equal(first.sendCode.headers["retry-after"], "60");

    failEmailVerifyConsume = false;
    const second = await sendEmailVerificationCode(
      agent,
      "email-verify-rate-limit-outage-second",
      "partial-rollback@example.com",
    );
    assert.equal(second.sendCode.status, 200);
  } finally {
    state.rateLimitService.consume = originalConsume;
    await state.persistence.runtime.close();
  }
});
