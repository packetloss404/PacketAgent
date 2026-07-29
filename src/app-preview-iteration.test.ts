import assert from "node:assert/strict";
import test from "node:test";
import {
  type PreviewErrorCapture,
  buildPreviewFixPromptHandoff,
  buildSmokeRerunRequest,
  buildSmokeRerunResult,
  capturePreviewBuildError,
  capturePreviewRuntimeError,
  derivePreviewRefreshState,
} from "./app-preview-iteration";
import type { AppSmokeCheck } from "./app-preview-readiness";

const CHECKS: AppSmokeCheck[] = [
  smokeCheck("page:home", "page", "Open home", "GET", "/", "browser"),
  smokeCheck("api:get:health", "api", "GET /api/health", "GET", "/api/health", "http"),
  smokeCheck("crud:post:tasks:create", "crud", "Create tasks", "POST", "/api/tasks", "http", 201),
];

test("derivePreviewRefreshState reports stale, refreshing, ready, and blocked states deterministically", () => {
  const stale = derivePreviewRefreshState({
    appId: "task-tracker",
    previewUrl: "http://localhost:5173/builder/preview/task-tracker",
    build: { phase: "passed", buildId: "build_2", revision: "rev_2" },
    lastRendered: {
      buildId: "build_1",
      revision: "rev_1",
      refreshedAt: "2026-05-03T12:00:00.000Z",
    },
  });

  assert.equal(stale.status, "stale");
  assert.equal(stale.needsRefresh, true);
  assert.equal(stale.canRequestRefresh, true);
  assert.equal(stale.canUsePreview, true);

  const refreshing = derivePreviewRefreshState({
    appId: "task-tracker",
    build: { phase: "passed", buildId: "build_2", revision: "rev_2" },
    lastRendered: {
      buildId: "build_1",
      revision: "rev_1",
      refreshedAt: "2026-05-03T12:00:00.000Z",
    },
    refreshRequest: {
      requestId: "refresh_123",
      buildId: "build_2",
      requestedAt: "2026-05-03T12:01:00.000Z",
    },
  });

  assert.equal(refreshing.status, "refreshing");
  assert.equal(refreshing.canRequestRefresh, false);
  assert.equal(refreshing.refreshRequest?.requestId, "refresh_123");

  const ready = derivePreviewRefreshState({
    appId: "task-tracker",
    build: { phase: "passed", buildId: "build_2", revision: "rev_2" },
    lastRendered: {
      buildId: "build_2",
      revision: "rev_2",
      refreshedAt: "2026-05-03T12:02:00.000Z",
    },
  });

  assert.equal(ready.status, "ready");
  assert.equal(ready.canUsePreview, true);
  assert.equal(ready.needsRefresh, false);

  const blocked = derivePreviewRefreshState({
    appId: "task-tracker",
    build: { phase: "failed", buildId: "build_3", message: "TypeScript failed." },
  });

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.canRequestRefresh, false);
  assert.equal(blocked.reason, "TypeScript failed.");
});

test("buildSmokeRerunRequest selects checks in stable order and blocks unknown ids", () => {
  const request = buildSmokeRerunRequest({
    appId: "Task Tracker",
    workspaceId: "alpha",
    buildId: "build_2",
    reason: "after-fix",
    attempt: 2,
    requestedAt: "2026-05-03T12:03:00.000Z",
    checks: CHECKS,
    checkIds: ["crud:post:tasks:create", "missing", "page:home"],
  });

  assert.match(request.requestId, /^smoke-rerun:task-tracker:build_2:2:/);
  assert.deepEqual(request.checkIds, ["crud:post:tasks:create", "page:home"]);
  assert.deepEqual(request.unknownCheckIds, ["missing"]);
  assert.equal(request.canRun, false);
  assert.match(request.message, /Unknown smoke check ids: missing/);

  const all = buildSmokeRerunRequest({ appId: "Task Tracker", checks: CHECKS });
  assert.deepEqual(all.checkIds, ["api:get:health", "crud:post:tasks:create", "page:home"]);
  assert.equal(all.canRun, true);
});

test("buildSmokeRerunResult summarizes outcomes and captures failed smoke errors", () => {
  const request = buildSmokeRerunRequest({
    appId: "task-tracker",
    buildId: "build_2",
    checks: CHECKS,
    checkIds: ["api:get:health", "page:home"],
  });
  const result = buildSmokeRerunResult({
    request,
    completedAt: "2026-05-03T12:04:00.000Z",
    outcomes: [
      { checkId: "api:get:health", status: "passed", durationMs: 18.7 },
      {
        checkId: "page:home",
        status: "failed",
        durationMs: 204,
        completedAt: "2026-05-03T12:04:00.000Z",
        error: new Error("Home crashed token=super-secret"),
      },
      { checkId: "not-requested", status: "passed" },
    ],
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.summary, {
    total: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    timedOut: 0,
    notRun: 0,
  });
  assert.deepEqual(result.failedCheckIds, ["page:home"]);
  assert.deepEqual(result.unknownOutcomeCheckIds, ["not-requested"]);
  assert.equal(result.results.find((entry) => entry.checkId === "api:get:health")?.durationMs, 18);
  assert.match(result.errorCaptures[0]?.message ?? "", /token=\[redacted\]/);
  assert.equal(result.errorCaptures[0]?.routePath, "/");
});

test("capturePreviewBuildError and capturePreviewRuntimeError redact secrets and fingerprint stably", () => {
  const first = capturePreviewBuildError({
    appId: "crm",
    buildId: "build_9",
    capturedAt: "2026-05-03T12:05:00.000Z",
    error: { name: "BuildError", message: "Vite failed authorization=Bearer abc123" },
    logs: ["Transform failed", "api_key=sk-test-123"],
    location: { filePath: "src/generated/App.tsx", line: 24.9, column: 8 },
  });
  const second = capturePreviewBuildError({
    appId: "crm",
    buildId: "build_9",
    capturedAt: "2026-05-03T12:06:00.000Z",
    error: { name: "BuildError", message: "Vite failed authorization=Bearer abc123" },
    logs: "api_key=sk-test-123",
    location: { filePath: "src/generated/App.tsx", line: 24, column: 8 },
  });

  assert.equal(first.source, "build");
  assert.match(first.message, /authorization=\[redacted\]/);
  assert.match(first.logExcerpt ?? "", /api_key=\[redacted\]/);
  assert.equal(first.location?.line, 24);
  assert.equal(first.fingerprint, second.fingerprint);

  const runtime = capturePreviewRuntimeError({
    appId: "crm",
    routePath: "accounts",
    error: new ReferenceError("AccountList is not defined password=hunter2"),
  });

  assert.equal(runtime.source, "runtime");
  assert.equal(runtime.routePath, "/accounts");
  assert.match(runtime.message, /password=\[redacted\]/);
});

test("buildPreviewFixPromptHandoff packages captured failures for builder repair", () => {
  const capture: PreviewErrorCapture = capturePreviewRuntimeError({
    appId: "booking",
    workspaceId: "alpha",
    buildId: "build_7",
    smokeCheckId: "page:booking-home",
    routePath: "/book",
    capturedAt: "2026-05-03T12:06:00.000Z",
    error: new Error("CalendarWidget is not defined secret=leak"),
    location: { filePath: "web/src/generated/Booking.tsx", line: 41 },
  });
  const smokeResult = buildSmokeRerunResult({
    request: buildSmokeRerunRequest({
      appId: "booking",
      buildId: "build_7",
      checks: [smokeCheck("page:booking-home", "page", "Open booking", "GET", "/book", "browser")],
    }),
    outcomes: [
      { checkId: "page:booking-home", status: "failed", error: "CalendarWidget is not defined" },
    ],
  });

  const handoff = buildPreviewFixPromptHandoff({
    capture,
    appName: "Clinic Booking",
    originalPrompt: "Build a booking app with token=do-not-send",
    routeMap: [
      { path: "/appointments", title: "Appointments" },
      { path: "book", title: "Book" },
    ],
    smokeResult,
    builderContext: ["Keep public booking route available."],
  });

  assert.equal(handoff.kind, "builder-fix-prompt-handoff");
  assert.equal(handoff.metadata.source, "runtime");
  assert.deepEqual(handoff.metadata.failedCheckIds, ["page:booking-home"]);
  assert.equal(handoff.readinessHandoff.metadata.routePath, "/book");
  assert.match(handoff.prompt, /Repair the generated app after a runtime failure/);
  assert.match(handoff.prompt, /Routes: \/appointments \(Appointments\), \/book \(Book\)/);
  assert.doesNotMatch(handoff.prompt, /leak|do-not-send/);
});

function smokeCheck(
  id: AppSmokeCheck["id"],
  kind: AppSmokeCheck["kind"],
  label: string,
  method: AppSmokeCheck["method"],
  path: string,
  runMode: AppSmokeCheck["runMode"],
  expectedStatus = 200,
): AppSmokeCheck {
  return {
    id,
    kind,
    label,
    method,
    path,
    runMode,
    requiredAuth: false,
    expectedStatus,
    sourceKey: id,
    assertions: ["renders"],
  };
}
