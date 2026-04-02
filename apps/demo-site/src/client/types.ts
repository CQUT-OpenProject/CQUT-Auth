export type StudentStatus = "active_student" | "not_student" | "unknown";

export type RequestStatus = "pending" | "running" | "succeeded" | "failed";

export type ErrorPayload = {
  error: string;
  error_description: string;
  retry_after_seconds?: number;
};

export type PendingResultPayload = {
  request_id: string;
  status: "pending" | "running";
  expires_at: string;
};

export type SucceededResultPayload = {
  request_id: string;
  status: "succeeded";
  verified?: boolean;
  student_status?: StudentStatus;
  school?: string;
  dedupe_key?: string;
  completed_at?: string;
};

export type FailedResultPayload = {
  request_id?: string;
  status?: "failed";
  error: string;
  error_description: string;
  completed_at?: string;
  retry_after_seconds?: number;
};

export type VerifyAcceptedPayload = {
  request_id: string;
  status: "pending";
  expires_at: string;
};

export type DemoVerifyRequest = {
  account: string;
  password: string;
  include_dedupe?: boolean;
};

export type DemoResponsePayload =
  | VerifyAcceptedPayload
  | PendingResultPayload
  | SucceededResultPayload
  | FailedResultPayload;
