import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { registerBuilderRoutes } from "./builder-core.js";

test("Builder route registration preserves the established API surface", () => {
  const app = new Hono();
  registerBuilderRoutes(app);

  assert.deepEqual(
    app.routes.map(({ method, path }) => `${method} ${path}`),
    [
      "POST /app/builder/agent-draft",
      "POST /app/builder/agent-draft/approve",
      "POST /app/builder/app-draft",
      "POST /app/builder/app-draft/stream",
      "GET /app/generated-apps",
      "GET /app/generated-apps/:appId/source",
      "GET /app/generated-apps/:appId/source-files",
      "GET /app/generated-apps/:appId/package-plan",
      "GET /app/generated-apps/:appId/export",
      "POST /app/builder/app-draft/apply",
      "POST /app/builder/app-draft/approve",
      "POST /app/builder/app-iteration",
      "POST /app/builder/app-iteration/apply",
      "POST /app/builder/app-iteration/stream",
      "POST /app/builder/changes/draft",
      "POST /app/builder/changes/apply",
      "POST /app/builder/preview/refresh",
      "POST /app/builder/fix-prompt",
      "GET /app/builder/checkpoints",
      "POST /app/builder/checkpoints/:checkpointId/rollback",
      "POST /app/builder/checkpoints/:checkpointId/branch",
      "POST /app/builder/publish/prepare",
      "POST /app/builder/publish/readiness",
      "POST /app/builder/publishes/readiness",
      "GET /app/builder/publish/state",
      "GET /app/builder/publish/history",
      "GET /app/builder/publishes",
      "GET /app/builder/publishes/history",
      "GET /app/generated-apps/:appId/publish/integrity",
      "GET /app/builder/publish/docker-compose",
      "GET /app/builder/publishes/docker-compose",
      "POST /app/builder/publish",
      "POST /app/builder/publishes",
      "POST /app/builder/publish/:publishId/rollback",
      "POST /app/builder/publishes/:publishId/rollback",
    ],
  );
});
