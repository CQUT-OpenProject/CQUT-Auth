export const OIDC_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "student",
] as const;
export const DEFAULT_OIDC_SCOPES = ["openid", "profile"] as const;
export type OidcScope = (typeof OIDC_SCOPES)[number];

export const OIDC_CLAIMS = [
  "sub",
  "preferred_username",
  "name",
  "email",
  "email_verified",
  "status",
] as const;
export type OidcClaim = (typeof OIDC_CLAIMS)[number];

export const STUDENT_STATUS = ["active", "not_student", "unknown"] as const;
export type StudentStatus = (typeof STUDENT_STATUS)[number];
