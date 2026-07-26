import { ClientManagementError } from "./management-error.js";

export function requireObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      "request body must be an object",
    );
  }
  return raw as Record<string, unknown>;
}

export function assertAllowedKeys(raw: unknown, allowed: readonly string[]) {
  const body = requireObject(raw);
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (unexpected) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      `unsupported request field: ${unexpected}`,
      unexpected,
    );
  }
  return body;
}

export function parsePositiveVersion(value: unknown, field: string) {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      `${field} must be a positive integer`,
      field,
    );
  }
  return Number(value);
}

export function parseText(
  value: unknown,
  field: string,
  min: number,
  max: number,
) {
  if (typeof value !== "string") {
    throw new ClientManagementError(
      400,
      "invalid_request",
      `${field} must be a string`,
      field,
    );
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ClientManagementError(
      400,
      "invalid_request",
      `${field} must contain ${min}-${max} characters`,
      field,
    );
  }
  return normalized;
}
