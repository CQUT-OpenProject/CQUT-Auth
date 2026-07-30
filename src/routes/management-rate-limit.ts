import {
  RateLimitService,
  RateLimitUnavailableError,
  resetRateLimitKeys,
  type RateLimitDecision,
} from "../persistence/rate-limit.service.js";
import { sha256 } from "../utils.js";

export function managementLoginRateLimitKeys(
  stage: "attempt" | "failure",
  account: string,
  ip: string,
) {
  const prefix = `oidc:login:${stage}`;
  const accountHash = sha256(account);
  return [
    `${prefix}:account:${accountHash}`,
    `${prefix}:ip:${ip}`,
    `${prefix}:account-ip:${accountHash}:${ip}`,
  ];
}

export async function enforceRateLimits(
  rateLimitService: RateLimitService,
  limits: Array<{ key: string; max: number }>,
  windowSeconds: number,
): Promise<{
  decision?: RateLimitDecision;
  consumedKeys: string[];
}> {
  const consumedKeys: string[] = [];
  try {
    for (const limit of limits) {
      const decision = await rateLimitService.consume(
        limit.key,
        limit.max,
        windowSeconds,
      );
      consumedKeys.push(limit.key);
      if (!decision.allowed) {
        await resetRateLimitKeys(rateLimitService, consumedKeys.slice(0, -1));
        return { decision, consumedKeys: [] };
      }
    }
    return { consumedKeys };
  } catch (error) {
    await resetRateLimitKeys(rateLimitService, consumedKeys).catch(
      (resetError) => {
        if (!(resetError instanceof RateLimitUnavailableError)) {
          throw resetError;
        }
      },
    );
    throw error;
  }
}

export async function consumeManagementLoginRateLimit(
  rateLimitService: RateLimitService,
  stage: "attempt" | "failure",
  account: string,
  ip: string,
  max: number,
  windowSeconds: number,
) {
  return enforceRateLimits(
    rateLimitService,
    managementLoginRateLimitKeys(stage, account, ip).map((key) => ({
      key,
      max,
    })),
    windowSeconds,
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
    managementLoginRateLimitKeys(stage, account, ip),
  );
}
