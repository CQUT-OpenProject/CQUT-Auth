import type { Request, Response } from "express";
import type { StaticConfig } from "../config.js";
import type {
  AuthenticatedPrincipal,
  InteractiveAuthenticatorService,
} from "../identity/index.js";
import { RetryableProviderError } from "../identity/errors.js";
import { hasSafeCredentialLengths } from "../identity/types.js";
import {
  RateLimitService,
  RateLimitUnavailableError,
  loginRateLimitKeys,
} from "../persistence/rate-limit.service.js";
import { resolveTrustedExpressRequestIp } from "../request-ip.js";
import {
  consumeManagementLoginRateLimit,
  resetManagementLoginRateLimit,
} from "./management-rate-limit.js";

type InteractiveLoginDeps = {
  config: StaticConfig;
  rateLimitService: RateLimitService;
  interactiveAuthenticator: InteractiveAuthenticatorService;
  request: Request;
  response: Response;
  logLabel: "management" | "agent";
};

export async function performInteractiveLogin(
  deps: InteractiveLoginDeps,
  onSuccess: (principal: AuthenticatedPrincipal) => Promise<void>,
): Promise<void> {
  const {
    config,
    rateLimitService,
    interactiveAuthenticator,
    request,
    response,
    logLabel,
  } = deps;
  const account =
    typeof request.body?.account === "string"
      ? request.body.account.trim().toLowerCase()
      : "";
  const password =
    typeof request.body?.password === "string" ? request.body.password : "";
  if (!hasSafeCredentialLengths(account, password)) {
    response.status(400).json({
      error: "invalid_request",
      error_description: "invalid credential length",
    });
    return;
  }
  const ip = resolveTrustedExpressRequestIp(config, request);
  const attempt = await consumeManagementLoginRateLimit(
    rateLimitService,
    "attempt",
    account,
    ip,
    config.loginRateLimitMax,
    config.loginRateLimitWindowSeconds,
  );
  if (attempt) {
    response.setHeader("Retry-After", String(attempt.retryAfterSeconds));
    response.status(429).json({
      error: "rate_limited",
      error_description: "login attempts exceeded",
    });
    return;
  }
  try {
    const principal = await interactiveAuthenticator.authenticate({
      provider: config.authProvider,
      account,
      password,
      ip,
      ...(request.get("user-agent")
        ? { userAgent: request.get("user-agent") as string }
        : {}),
    });
    await Promise.all(
      loginRateLimitKeys("failure", account, ip)
        .filter((key) => !key.includes(":ip:"))
        .map((key) => rateLimitService.reset(key)),
    ).catch(() => undefined);
    await onSuccess(principal);
  } catch (error) {
    if (error instanceof RetryableProviderError) {
      console.error(
        `[oidc-op] ${logLabel} sign-in upstream unavailable`,
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : "unknown error",
      );
      await resetManagementLoginRateLimit(
        rateLimitService,
        "attempt",
        account,
        ip,
      );
      response.setHeader("Retry-After", "60");
      response.status(503).json({
        error: "service_unavailable",
        error_description: "try again later",
      });
      return;
    }
    let failure;
    try {
      failure = await consumeManagementLoginRateLimit(
        rateLimitService,
        "failure",
        account,
        ip,
        config.loginFailureLimit,
        config.loginFailureWindowSeconds,
      );
    } catch (consumeError) {
      if (consumeError instanceof RateLimitUnavailableError) {
        await resetManagementLoginRateLimit(
          rateLimitService,
          "attempt",
          account,
          ip,
        );
        response.setHeader("Retry-After", "60");
        response.status(503).json({
          error: "service_unavailable",
          error_description: "try again later",
        });
        return;
      }
      throw consumeError;
    }
    if (failure) {
      response.setHeader("Retry-After", String(failure.retryAfterSeconds));
      response.status(429).json({
        error: "rate_limited",
        error_description: "login failures exceeded",
      });
      return;
    }
    console.error(
      `[oidc-op] ${logLabel} sign-in failed`,
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : "unknown error",
    );
    response.status(401).json({
      error: "access_denied",
      error_description: "invalid account or password",
    });
  }
}

export function handleInteractiveLoginOuterError(
  error: unknown,
  response: Response,
  next: (error: unknown) => void,
) {
  if (error instanceof RateLimitUnavailableError) {
    response.setHeader("Retry-After", "60");
    response.status(503).json({
      error: "service_unavailable",
      error_description: "try again later",
    });
    return;
  }
  next(error);
}
