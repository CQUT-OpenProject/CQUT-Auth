import { requestJson } from "./api.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEMO_API,
  INITIAL_POLL_INTERVAL_MS,
  POLL_BACKOFF_FACTOR,
  UI_LABELS,
  UI_TEXT
} from "./config.js";
import type { DemoResponsePayload, FailedResultPayload } from "./types.js";
import { createView, type Mode } from "./view.js";

declare global {
  interface Window {
    __CQUT_DEMO_CONFIG__?: {
      pollIntervalMs?: number;
    };
  }
}

const config = window.__CQUT_DEMO_CONFIG__ ?? {};
const pollIntervalMs =
  typeof config.pollIntervalMs === "number" ? config.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;

const view = createView();

let activeToken = 0;
let latestRequestId = "";
let pollTimer = 0;
let nextPollDelayMs = Math.min(INITIAL_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);

function clearPolling() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }
}

function renderError(
  mode: Extract<Mode, "failed" | "rate_limited">,
  payload: FailedResultPayload | Record<string, unknown>,
  fallbackText: string
) {
  const errorMessage =
    typeof payload.error_description === "string" ? payload.error_description : fallbackText;

  view.setMode(mode, errorMessage);
  view.setFields(payload);
  view.setRawResponse(payload);
  view.setButtonState(false, UI_LABELS.idleButton);
}

function resetPollDelay() {
  nextPollDelayMs = Math.min(INITIAL_POLL_INTERVAL_MS, pollIntervalMs);
}

function getNextPollDelay() {
  const current = nextPollDelayMs;
  nextPollDelayMs = Math.min(pollIntervalMs, Math.max(INITIAL_POLL_INTERVAL_MS, Math.round(current * POLL_BACKOFF_FACTOR)));
  return current;
}

function schedulePoll(token: number, delayMs = getNextPollDelay()) {
  clearPolling();
  pollTimer = window.setTimeout(() => {
    void pollResult(token);
  }, delayMs);
}

function isRateLimitedPayload(payload: DemoResponsePayload | Record<string, unknown>) {
  return (payload as Record<string, unknown>)["error"] === "rate_limited";
}

async function pollResult(token: number) {
  if (token !== activeToken || !latestRequestId) {
    return;
  }

  try {
    const result = await requestJson(window.fetch.bind(window), DEMO_API.result(latestRequestId), {
      headers: {
        Accept: "application/json"
      }
    });

    if (token !== activeToken) {
      return;
    }

    const body = result.body;
    view.setRawResponse(body);
    view.setFields(body);

    if (!result.ok) {
      renderError(isRateLimitedPayload(body) ? "rate_limited" : "failed", body, UI_TEXT.resultQueryFailed);
      return;
    }

    if (body.status === "pending" || body.status === "running") {
      view.setMode("polling", body.status === "running" ? UI_TEXT.pollingRunning : UI_TEXT.pollingPending);
      schedulePoll(token);
      return;
    }

    if (body.status === "succeeded") {
      view.setMode("succeeded");
      view.setButtonState(false, UI_LABELS.idleButton);
      return;
    }

    renderError("failed", body, UI_TEXT.verifyRejected);
  } catch {
    if (token !== activeToken) {
      return;
    }

    renderError("failed", {
      error: "server_error",
      error_description: "demo page failed to fetch result"
    }, UI_TEXT.resultQueryFailed);
  }
}

async function onSubmit(event: SubmitEvent) {
  event.preventDefault();
  activeToken += 1;
  const token = activeToken;
  clearPolling();
  resetPollDelay();
  latestRequestId = "";

  const { account, password, includeDedupe } = view.readFormState();

  if (!account || !password) {
    renderError("failed", {
      error: "invalid_request",
      error_description: "请先填写帐号和密码"
    }, UI_TEXT.missingCredentials);
    return;
  }

  view.setButtonState(true, UI_LABELS.busyButton);
  view.setMode("submitting");

  try {
    const result = await requestJson(window.fetch.bind(window), DEMO_API.verify, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        account,
        password,
        ...(includeDedupe ? { include_dedupe: true } : {})
      })
    });

    if (token !== activeToken) {
      return;
    }

    const body = result.body;
    view.setRawResponse(body);
    view.setFields(body);

    if (!result.ok) {
      renderError(isRateLimitedPayload(body) ? "rate_limited" : "failed", body, UI_TEXT.verifySubmitFailed);
      return;
    }

    latestRequestId = typeof body.request_id === "string" ? body.request_id : "";
    view.setMode("polling");
    schedulePoll(token, 0);
  } catch {
    if (token !== activeToken) {
      return;
    }

    renderError("failed", {
      error: "server_error",
      error_description: "demo page failed to submit request"
    }, UI_TEXT.verifySubmitFailed);
  }
}

function initDemoPage() {
  if (!view.form) {
    return;
  }

  view.setRawResponse(null);
  view.setFields(null);
  view.setMode("idle");
  resetPollDelay();
  view.form.addEventListener("submit", onSubmit);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initDemoPage);
} else {
  initDemoPage();
}
