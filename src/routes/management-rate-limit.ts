import {
  RateLimitService,
  RateLimitUnavailableError,
  consumeRateLimitChecks,
  loginRateLimitKeys,
  resetRateLimitKeys,
} from "../persistence/rate-limit.service.js";

export async function enforceRateLimits(
  rateLimitService: RateLimitService,
  limits: Array<{ key: string; max: number }>,
  windowSeconds: number,
) {
  return consumeRateLimitChecks(
    rateLimitService,
    limits.map((limit) => ({ ...limit, windowSeconds })),
  );
}

export async function consumeManagementLoginRateLimit(
  rateLimitService: RateLimitService,
  stage: "attempt" | "failure",
  account: string,
  ip: string,
  max: number,
  windowSeconds: number,
) {
  return consumeRateLimitChecks(
    rateLimitService,
    loginRateLimitKeys(stage, account, ip).map((key) => ({
      key,
      max,
      windowSeconds,
    })),
  ).then(({ decision }) => decision);
}

export async function resetManagementLoginRateLimit(
  rateLimitService: RateLimitService,
  stage: "attempt" | "failure",
  account: string,
  ip: string,
) {
  await resetRateLimitKeys(
    rateLimitService,
    loginRateLimitKeys(stage, account, ip),
  );
}
