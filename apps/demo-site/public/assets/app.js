"use strict";
(() => {
  // src/client/api.ts
  async function requestJson(fetchImpl, url, init) {
    const response = await fetchImpl(url, init);
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {
          error: "server_error",
          error_description: "demo page failed to parse response"
        };
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      retryAfter: response.headers.get("Retry-After"),
      body
    };
  }

  // src/client/config.ts
  var DEFAULT_POLL_INTERVAL_MS = 1200;
  var INITIAL_POLL_INTERVAL_MS = 150;
  var POLL_BACKOFF_FACTOR = 1.8;
  var DEMO_API = {
    verify: "/demo/api/verify",
    result(requestId) {
      return "/demo/api/result/" + encodeURIComponent(requestId);
    }
  };
  var UI_LABELS = {
    idleButton: "Verify",
    busyButton: "Working..."
  };
  var UI_TEXT = {
    placeholderJson: '{\n  "hint": "recent response will appear here"\n}',
    pollingRunning: "processing",
    pollingPending: "waiting for result",
    missingCredentials: "\u7F3A\u5C11\u51ED\u636E",
    verifySubmitFailed: "\u63D0\u4EA4\u9A8C\u8BC1\u8BF7\u6C42\u5931\u8D25",
    verifyRejected: "\u9A8C\u8BC1\u672A\u901A\u8FC7",
    resultQueryFailed: "\u67E5\u8BE2\u7ED3\u679C\u5931\u8D25"
  };
  var MODE_COPY = {
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

  // src/client/selectors.ts
  var DOM_IDS = {
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
  };
  var RESULT_FIELD_IDS = {
    request_id: DOM_IDS.requestId,
    status: DOM_IDS.requestStatus,
    completed_at: DOM_IDS.completedAt,
    student_status: DOM_IDS.studentStatus,
    school: DOM_IDS.school,
    dedupe_key: DOM_IDS.dedupeKey
  };

  // src/client/view.ts
  function byId(id) {
    return document.getElementById(id);
  }
  function setText(node, value) {
    if (node) {
      node.textContent = value || "-";
    }
  }
  function asRecord(payload) {
    return payload;
  }
  function getStringField(payload, field) {
    const value = asRecord(payload)[field];
    return typeof value === "string" ? value : "-";
  }
  function getRetryAfterField(payload) {
    const value = asRecord(payload)["retry_after_seconds"];
    return typeof value === "number" || typeof value === "string" ? String(value) : "-";
  }
  function createView() {
    const form = byId(DOM_IDS.form);
    const accountInput = byId(DOM_IDS.accountInput);
    const passwordInput = byId(DOM_IDS.passwordInput);
    const dedupeToggle = byId(DOM_IDS.dedupeToggle);
    const submitButton = byId(DOM_IDS.submitButton);
    const rawResponse = byId(DOM_IDS.rawResponse);
    const stateBadge = byId(DOM_IDS.stateBadge);
    const stateTitle = byId(DOM_IDS.stateTitle);
    const stateDetail = byId(DOM_IDS.stateDetail);
    const resultFields = Object.fromEntries(
      Object.entries(RESULT_FIELD_IDS).map(([field, id]) => [field, byId(id)])
    );
    const retryAfter = byId(DOM_IDS.retryAfter);
    return {
      form,
      readFormState() {
        return {
          account: accountInput?.value.trim() ?? "",
          password: passwordInput?.value ?? "",
          includeDedupe: dedupeToggle?.checked ?? false
        };
      },
      setButtonState(isBusy, label) {
        if (!submitButton) {
          return;
        }
        submitButton.disabled = isBusy;
        submitButton.textContent = label;
      },
      setRawResponse(payload) {
        if (rawResponse) {
          rawResponse.textContent = payload ? JSON.stringify(payload, null, 2) : UI_TEXT.placeholderJson;
        }
      },
      setMode(mode, detailOverride) {
        const copy = MODE_COPY[mode] ?? MODE_COPY.failed;
        if (stateBadge) {
          stateBadge.dataset["mode"] = mode;
          stateBadge.textContent = mode.toUpperCase();
        }
        setText(stateTitle, copy.title);
        if (stateDetail) {
          stateDetail.textContent = detailOverride ?? copy.detail;
        }
        setText(resultFields.status, mode === "idle" ? "idle" : mode);
      },
      setFields(payload) {
        const data = payload ?? {};
        for (const field of Object.keys(RESULT_FIELD_IDS)) {
          setText(resultFields[field], getStringField(data, field));
        }
        setText(retryAfter, getRetryAfterField(data));
      }
    };
  }

  // src/client/main.ts
  var config = window.__CQUT_DEMO_CONFIG__ ?? {};
  var pollIntervalMs = typeof config.pollIntervalMs === "number" ? config.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  var view = createView();
  var activeToken = 0;
  var latestRequestId = "";
  var pollTimer = 0;
  var nextPollDelayMs = Math.min(INITIAL_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);
  function clearPolling() {
    if (pollTimer) {
      window.clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }
  function renderError(mode, payload, fallbackText) {
    const errorMessage = typeof payload.error_description === "string" ? payload.error_description : fallbackText;
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
  function schedulePoll(token, delayMs = getNextPollDelay()) {
    clearPolling();
    pollTimer = window.setTimeout(() => {
      void pollResult(token);
    }, delayMs);
  }
  function isRateLimitedPayload(payload) {
    return payload["error"] === "rate_limited";
  }
  async function pollResult(token) {
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
  async function onSubmit(event) {
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
        error_description: "\u8BF7\u5148\u586B\u5199\u5E10\u53F7\u548C\u5BC6\u7801"
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
          ...includeDedupe ? { include_dedupe: true } : {}
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
})();
//# sourceMappingURL=app.js.map
