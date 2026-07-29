import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppPreviewReadiness,
  buildRuntimeErrorHandoff,
  deriveAppPreviewTarget,
  deriveAppSmokeChecks,
  derivePreviewBuildStatus,
} from "./app-preview-readiness";

test("deriveAppPreviewTarget builds deterministic preview paths and URLs", () => {
  const preview = deriveAppPreviewTarget({
    appId: "Task Tracker",
    workspaceId: "Alpha Team",
    baseUrl: "http://localhost:5173",
    pageMap: [
      { key: "settings", path: "/settings", visibility: "private" },
      { key: "dashboard", path: "dashboard", visibility: "private" },
      { key: "public-portal", path: "/portal", visibility: "public", supportsMobilePreview: true },
    ],
  });

  assert.equal(preview.entryPath, "/portal");
  assert.equal(preview.path, "/builder/preview/alpha-team/task-tracker/portal");
  assert.equal(preview.url, "http://localhost:5173/builder/preview/alpha-team/task-tracker/portal");
  assert.equal(preview.mobilePath, "/builder/preview/alpha-team/task-tracker/portal");
  assert.equal(preview.qrPath, "/builder/preview/alpha-team/task-tracker/portal?device=mobile");
});

test("deriveAppPreviewTarget honors preferred path over page map defaults", () => {
  const preview = deriveAppPreviewTarget({
    appId: "crm",
    previewBasePath: "/preview",
    preferredPath: "accounts/active",
    pageMap: [{ key: "home", path: "/" }],
  });

  assert.equal(preview.entryPath, "/accounts/active");
  assert.equal(preview.path, "/preview/crm/accounts/active");
  assert.equal(preview.url, undefined);
});

test("deriveAppSmokeChecks derives page, safe API, and CRUD checks in stable order", () => {
  const checks = deriveAppSmokeChecks({
    pageMap: [
      { key: "task-detail", path: "/tasks/:id", visibility: "private" },
      { key: "home", path: "/", title: "Home", visibility: "public" },
    ],
    apiRoutes: [
      { key: "create-task", method: "POST", path: "/api/tasks" },
      { key: "health", method: "GET", path: "/api/health", authRequired: false },
      {
        key: "preview-create-task",
        method: "POST",
        path: "/api/tasks/preview",
        smoke: true,
        expectedStatus: 202,
      },
    ],
    crudFlows: [
      {
        key: "tasks",
        resource: "tasks",
        apiBasePath: "/api/tasks",
        detailPath: "/api/tasks/:id",
        operations: ["list", "create", "read", "update", "delete"],
      },
    ],
  });

  assert.deepEqual(
    checks.map((check) => check.id),
    [
      "page:home",
      "page:task-detail",
      "api:get:health",
      "api:post:preview-create-task",
      "crud:get:tasks:list",
      "crud:post:tasks:create",
      "crud:get:tasks:read",
      "crud:patch:tasks:update",
      "crud:delete:tasks:delete",
    ],
  );
  assert.equal(checks.find((check) => check.id === "api:get:health")?.requiredAuth, false);
  assert.equal(
    checks.find((check) => check.id === "api:post:preview-create-task")?.expectedStatus,
    202,
  );
  assert.equal(
    checks.some((check) => check.id === "api:post:create-task"),
    false,
  );
  assert.equal(checks.find((check) => check.id === "crud:post:tasks:create")?.expectedStatus, 201);
});

test("derivePreviewBuildStatus exposes builder-ready labels", () => {
  assert.deepEqual(derivePreviewBuildStatus({ phase: "passed", checkCount: 3, passedChecks: 3 }), {
    phase: "passed",
    label: "Ready to preview",
    tone: "success",
    canPreview: true,
    canPublish: true,
    summary: "Build passed. 3/3 checks passed.",
  });

  assert.deepEqual(derivePreviewBuildStatus({ phase: "running", checkCount: 4, passedChecks: 1 }), {
    phase: "running",
    label: "Running checks",
    tone: "working",
    canPreview: false,
    canPublish: false,
    summary: "Preview build is running. 1/4 checks passed.",
  });

  assert.deepEqual(
    derivePreviewBuildStatus({ phase: "passed", failedChecks: 1, passedChecks: 2 }),
    {
      phase: "failed",
      label: "Needs fix",
      tone: "danger",
      canPreview: false,
      canPublish: false,
      summary: "Build or smoke checks failed. 2/3 checks passed.",
    },
  );
});

test("buildRuntimeErrorHandoff redacts secret-like values and preserves fix context", () => {
  const handoff = buildRuntimeErrorHandoff({
    appId: "crm",
    workspaceId: "alpha",
    routePath: "accounts",
    source: "preview",
    buildId: "build_123",
    smokeCheckId: "page:accounts",
    capturedAt: "2026-05-03T12:00:00.000Z",
    error: new Error("Request failed authorization=Bearer abc123 token=secret-token"),
  });

  assert.equal(handoff.kind, "runtime-error-fix");
  assert.equal(handoff.title, "Fix preview error");
  assert.equal(handoff.metadata.routePath, "/accounts");
  assert.equal(handoff.metadata.source, "preview");
  assert.equal(handoff.metadata.buildId, "build_123");
  assert.equal(handoff.metadata.smokeCheckId, "page:accounts");
  assert.match(handoff.prompt, /Fix the generated app preview error/);
  assert.match(handoff.metadata.message, /authorization=\[redacted\]/);
  assert.match(handoff.metadata.message, /token=\[redacted\]/);
  assert.doesNotMatch(handoff.prompt, /abc123|secret-token/);
});

test("buildAppPreviewReadiness composes preview, smoke, build, and handoff metadata", () => {
  const readiness = buildAppPreviewReadiness({
    appId: "booking",
    workspaceId: "alpha",
    baseUrl: "http://localhost:4173",
    pageMap: [{ key: "booking-home", path: "/", visibility: "public" }],
    apiRoutes: [
      { key: "availability", method: "GET", path: "/api/availability", authRequired: false },
    ],
    crudFlows: [
      {
        key: "appointments",
        resource: "appointments",
        apiBasePath: "/api/appointments",
        operations: ["list"],
      },
    ],
    build: { phase: "queued" },
    runtimeError: {
      appId: "booking",
      workspaceId: "alpha",
      source: "smoke",
      smokeCheckId: "page:booking-home",
      error: { name: "ReferenceError", message: "CalendarWidget is not defined" },
    },
  });

  assert.equal(readiness.preview.url, "http://localhost:4173/builder/preview/alpha/booking");
  assert.deepEqual(
    readiness.smokeChecks.map((check) => check.id),
    ["page:booking-home", "api:get:availability", "crud:get:appointments:list"],
  );
  assert.equal(readiness.buildStatus.label, "Queued");
  assert.equal(readiness.runtimeErrorHandoff?.metadata.name, "ReferenceError");
});
