import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedPrincipal } from "../identity/index.js";
import { ClientManagementError } from "../management/management-error.js";
import { RateLimitUnavailableError } from "../persistence/rate-limit.service.js";
import type { ProjectActor } from "../projects/project-access.js";

export type ManagementAuth = {
  token: string;
  principal: AuthenticatedPrincipal;
  actor: ProjectActor;
};

export type ManagementRouteGuard = (
  request: Request,
  response: Response,
  next: NextFunction,
  handler: (auth: ManagementAuth) => Promise<void>,
) => Promise<void>;

export function routeParam(request: Request, name: string) {
  const value = request.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function writeRateLimited(
  response: Response,
  decision: { retryAfterSeconds: number },
  description: string,
) {
  response.setHeader("Retry-After", String(decision.retryAfterSeconds));
  response.status(429).json({
    error: "rate_limited",
    error_description: description,
  });
}

export function handleManagementError(
  error: unknown,
  response: Response,
  next: NextFunction,
) {
  if (error instanceof ClientManagementError) {
    if (error.retryAfterSeconds !== undefined) {
      response.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    response.status(error.status).json({
      error: error.code,
      error_description: error.message,
      ...(error.field
        ? { field_errors: { [error.field]: error.message } }
        : {}),
    });
    return;
  }
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

export function jsonBodyErrorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
) {
  const status = (error as { status?: unknown }).status;
  if (status === 400) {
    response.status(400).json({
      error: "invalid_request",
      error_description: "invalid JSON request body",
    });
    return;
  }
  handleManagementError(error, response, next);
}
