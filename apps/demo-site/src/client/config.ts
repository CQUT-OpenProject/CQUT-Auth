import type { Mode } from "./view.js";

export const DEFAULT_POLL_INTERVAL_MS = 1200;
export const INITIAL_POLL_INTERVAL_MS = 150;
export const POLL_BACKOFF_FACTOR = 1.8;

export const DEMO_API = {
  verify: "/demo/api/verify",
  result(requestId: string) {
    return "/demo/api/result/" + encodeURIComponent(requestId);
  }
} as const;

export const UI_LABELS = {
  idleButton: "Verify",
  busyButton: "Working..."
} as const;

export const UI_TEXT = {
  placeholderJson: '{\n  "hint": "recent response will appear here"\n}',
  pollingRunning: "processing",
  pollingPending: "waiting for result",
  missingCredentials: "缺少凭据",
  verifySubmitFailed: "提交验证请求失败",
  verifyRejected: "验证未通过",
  resultQueryFailed: "查询结果失败"
} as const;

export const MODE_COPY: Record<Mode, { title: string; detail: string }> = {
  idle: {
    title: "READY",
    detail: ""
  },
  submitting: {
    title: "SUBMIT",
    detail: "creating request"
  },
  polling: {
    title: "POLLING",
    detail: UI_TEXT.pollingPending
  },
  succeeded: {
    title: "DONE",
    detail: "response received"
  },
  failed: {
    title: "FAILED",
    detail: "request ended with error"
  },
  rate_limited: {
    title: "LIMITED",
    detail: "too many requests"
  }
};
