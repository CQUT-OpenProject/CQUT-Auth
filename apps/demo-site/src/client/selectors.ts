export const DOM_IDS = {
  form: "verify-form",
  accountInput: "account-input",
  passwordInput: "password-input",
  dedupeToggle: "dedupe-toggle",
  submitButton: "submit-button",
  rawResponse: "raw-response",
  stateBadge: "state-badge",
  stateTitle: "state-title",
  stateDetail: "state-detail",
  requestId: "request-id",
  requestStatus: "request-status",
  completedAt: "completed-at",
  studentStatus: "student-status",
  school: "school",
  dedupeKey: "dedupe-key",
  retryAfter: "retry-after"
} as const;

export const RESULT_FIELD_IDS = {
  request_id: DOM_IDS.requestId,
  status: DOM_IDS.requestStatus,
  completed_at: DOM_IDS.completedAt,
  student_status: DOM_IDS.studentStatus,
  school: DOM_IDS.school,
  dedupe_key: DOM_IDS.dedupeKey
} as const;
