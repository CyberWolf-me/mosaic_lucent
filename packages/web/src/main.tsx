import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initPostHog, track } from "./analytics/posthog.js";

initPostHog();

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

/**
 * Surface a mount-time crash in the DOM rather than only in the console.
 * A blank page with a console-only stack is the hardest failure mode to
 * diagnose in a deployed build, and this costs one try/catch.
 */
try {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (err) {
  root.textContent = `Lucent failed to start: ${(err as Error).message}`;
  throw err;
}

window.addEventListener("error", (e) => {
  if (root.childElementCount === 0 && root.textContent === "") {
    root.textContent = `Lucent failed to start: ${e.message}`;
  }
  track("client_error", { message: e.message, filename: e.filename, lineno: e.lineno });
});
window.addEventListener("unhandledrejection", (e) => {
  if (root.childElementCount === 0 && root.textContent === "") {
    root.textContent = `Lucent failed to start: ${String(e.reason)}`;
  }
  track("client_unhandled_rejection", { reason: String(e.reason) });
});
