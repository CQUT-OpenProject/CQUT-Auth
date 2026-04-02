import type { StudentStatus, SupportedScope } from "@cqut/shared";

export type ClientConfig = {
  clientId: string;
  clientSecretHash: string;
  allowedScopes: SupportedScope[];
  status: "active" | "disabled";
  createdAt: string;
};

export type VerificationIdentity = {
  schoolUid: string;
  verified: boolean;
  studentStatus: StudentStatus;
  school: string;
  identityHash?: string;
};

export type VerificationRequestStatus = "pending" | "running" | "succeeded" | "failed";
export type VerificationJobStatus = "queued" | "running" | "succeeded" | "failed";

export type VerificationRequest = {
  requestId: string;
  clientId: string;
  scope: SupportedScope[];
  status: VerificationRequestStatus;
  verified?: boolean | undefined;
  studentStatus?: StudentStatus | undefined;
  school?: string | undefined;
  dedupeKey?: string | undefined;
  internalIdentityHash?: string | undefined;
  error?: string | undefined;
  errorDescription?: string | undefined;
  createdAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  expiresAt: string;
};

export type VerificationJob = {
  jobId: string;
  requestId: string;
  clientId: string;
  provider: string;
  payloadCiphertext?: string | undefined;
  status: VerificationJobStatus;
  attemptCount: number;
  availableAt: string;
  createdAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  lastError?: string | undefined;
};
