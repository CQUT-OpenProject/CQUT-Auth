import React from "react";
import { createRoot } from "react-dom/client";
import { DemoApp } from "./DemoApp.js";
import "./styles.css";
import type { DemoClientState } from "./types.js";

const rootElement = document.getElementById("root");
const rawState = rootElement?.getAttribute("data-state");
const state: DemoClientState | undefined = rawState
  ? (JSON.parse(decodeURIComponent(rawState)) as DemoClientState)
  : undefined;

if (rootElement && state) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <DemoApp initialState={state} />
    </React.StrictMode>
  );
}
