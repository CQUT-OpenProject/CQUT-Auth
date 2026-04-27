export const DEFAULT_SCOPES = ["student.verify"] as const;
export const DEDUPE_SCOPE = "student.dedupe";

export const SUPPORTED_SCOPES = ["student.verify", "student.dedupe"] as const;
export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

export const OIDC_SCOPES = ["openid", "profile", "email", "offline_access", "student"] as const;
export const DEFAULT_OIDC_SCOPES = ["openid", "profile"] as const;
export type OidcScope = (typeof OIDC_SCOPES)[number];

export const OIDC_CLAIMS = [
  "sub",
  "preferred_username",
  "name",
  "email",
  "email_verified",
  "status"
] as const;
export type OidcClaim = (typeof OIDC_CLAIMS)[number];

export const STUDENT_STATUS = [
  "active_student",
  "not_student",
  "unknown"
] as const;
export type StudentStatus = (typeof STUDENT_STATUS)[number];

export const API_ERRORS = [
  "invalid_request",
  "invalid_client",
  "invalid_scope",
  "rate_limited",
  "verification_failed",
  "server_error"
] as const;
export type ApiErrorCode = (typeof API_ERRORS)[number];

export type ErrorResponse = {
  error: ApiErrorCode | string;
  error_description: string;
  retry_after_seconds?: number;
};
