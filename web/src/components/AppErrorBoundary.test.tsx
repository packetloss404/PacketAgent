import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppErrorBoundary, AppErrorFallback } from "./AppErrorBoundary";

test("the app error boundary transitions to a generic recovery state", () => {
  assert.deepEqual(AppErrorBoundary.getDerivedStateFromError(), { failed: true });
});

test("the app error fallback explains durable state and exposes recovery actions", () => {
  const markup = renderToStaticMarkup(<AppErrorFallback />);

  assert.match(markup, /role="alert"/);
  assert.match(markup, /server-side Workers keep their durable state/);
  assert.match(markup, /Reload workbench/);
  assert.match(markup, /Return home/);
});
