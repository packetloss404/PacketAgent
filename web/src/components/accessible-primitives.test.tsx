import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessibleTabPanel, AccessibleTabs } from "./AccessibleTabs.js";
import { AsyncStateBoundary } from "./AsyncStateBoundary.js";
import { nextTabIndex } from "./tab-navigation.js";

test("tab keyboard navigation wraps and honors Home and End", () => {
  assert.equal(nextTabIndex(0, 4, "ArrowLeft"), 3);
  assert.equal(nextTabIndex(3, 4, "ArrowRight"), 0);
  assert.equal(nextTabIndex(2, 4, "Home"), 0);
  assert.equal(nextTabIndex(1, 4, "End"), 3);
  assert.equal(nextTabIndex(0, 0, "ArrowRight"), -1);
});

test("accessible tabs expose one focusable selection and a labelled panel", () => {
  const markup = renderToStaticMarkup(
    <>
      <AccessibleTabs
        id="builder"
        label="Builder views"
        activeId="preview"
        tabs={[
          { id: "preview", label: "Preview" },
          { id: "files", label: "Files" },
        ]}
        onSelect={() => undefined}
      />
      <AccessibleTabPanel id="builder" tabId="preview">
        Preview content
      </AccessibleTabPanel>
    </>,
  );

  assert.match(markup, /role="tablist" aria-label="Builder views"/);
  assert.match(
    markup,
    /id="builder-tab-preview" role="tab" aria-selected="true" aria-controls="builder-panel-preview" tabindex="0"/,
  );
  assert.match(markup, /id="builder-tab-files" role="tab" aria-selected="false"[^>]+tabindex="-1"/);
  assert.match(
    markup,
    /id="builder-panel-preview" role="tabpanel" aria-labelledby="builder-tab-preview"/,
  );
});

test("async boundaries distinguish polite progress, assertive errors, retry, and empty status", () => {
  const loading = renderToStaticMarkup(
    <AsyncStateBoundary
      state={{ kind: "loading", message: "Loading Workers…", role: "status", ariaLive: "polite" }}
    />,
  );
  const error = renderToStaticMarkup(
    <AsyncStateBoundary
      state={{
        kind: "error",
        message: "Workers unavailable.",
        role: "alert",
        ariaLive: "assertive",
      }}
      onRetry={() => undefined}
      retryLabel="Retry Workers"
    />,
  );
  const empty = renderToStaticMarkup(
    <AsyncStateBoundary
      inline
      state={{ kind: "empty", message: "No Workers.", role: "status", ariaLive: "polite" }}
    />,
  );

  assert.match(loading, /role="status" aria-live="polite" aria-atomic="true" data-state="loading"/);
  assert.match(error, /role="alert" aria-live="assertive" aria-atomic="true" data-state="error"/);
  assert.match(error, /<button type="button" class="btn btn-sm">Retry Workers<\/button>/);
  assert.match(empty, /<span role="status" aria-live="polite"[^>]+data-state="empty"/);
});
