import type { DemoResponsePayload } from "./types.js";
import { MODE_COPY, UI_TEXT } from "./config.js";
import { DOM_IDS, RESULT_FIELD_IDS } from "./selectors.js";

export type Mode = "idle" | "submitting" | "polling" | "succeeded" | "failed" | "rate_limited";

type ResultFieldKey = keyof typeof RESULT_FIELD_IDS;

type View = {
  form: HTMLFormElement | null;
  readFormState: () => { account: string; password: string; includeDedupe: boolean };
  setButtonState: (isBusy: boolean, label: string) => void;
  setRawResponse: (payload: DemoResponsePayload | Record<string, unknown> | null) => void;
  setMode: (mode: Mode, detailOverride?: string) => void;
  setFields: (payload: DemoResponsePayload | Record<string, unknown> | null) => void;
};

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(node: HTMLElement | null, value: string) {
  if (node) {
    node.textContent = value || "-";
  }
}

function asRecord(payload: DemoResponsePayload | Record<string, unknown>) {
  return payload as Record<string, unknown>;
}

function getStringField(payload: DemoResponsePayload | Record<string, unknown>, field: string) {
  const value = asRecord(payload)[field];
  return typeof value === "string" ? value : "-";
}

function getRetryAfterField(payload: DemoResponsePayload | Record<string, unknown>) {
  const value = asRecord(payload)["retry_after_seconds"];
  return typeof value === "number" || typeof value === "string" ? String(value) : "-";
}

export function createView(): View {
  const form = byId<HTMLFormElement>(DOM_IDS.form);
  const accountInput = byId<HTMLInputElement>(DOM_IDS.accountInput);
  const passwordInput = byId<HTMLInputElement>(DOM_IDS.passwordInput);
  const dedupeToggle = byId<HTMLInputElement>(DOM_IDS.dedupeToggle);
  const submitButton = byId<HTMLButtonElement>(DOM_IDS.submitButton);
  const rawResponse = byId<HTMLElement>(DOM_IDS.rawResponse);
  const stateBadge = byId<HTMLElement>(DOM_IDS.stateBadge);
  const stateTitle = byId<HTMLElement>(DOM_IDS.stateTitle);
  const stateDetail = byId<HTMLElement>(DOM_IDS.stateDetail);
  const resultFields = Object.fromEntries(
    Object.entries(RESULT_FIELD_IDS).map(([field, id]) => [field, byId<HTMLElement>(id)])
  ) as Record<ResultFieldKey, HTMLElement | null>;
  const retryAfter = byId<HTMLElement>(DOM_IDS.retryAfter);

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

      for (const field of Object.keys(RESULT_FIELD_IDS) as ResultFieldKey[]) {
        setText(resultFields[field], getStringField(data, field));
      }

      setText(retryAfter, getRetryAfterField(data));
    }
  };
}
