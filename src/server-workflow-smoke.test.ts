import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { resetStoreForTests } from "./packetagent-store";
import { workflowRoutes } from "./workflow-routes";

const workflowEndpoints = [
  ["GET", "/api/app/workflow"],
  ["GET", "/api/app/workflow/brief"],
  ["PUT", "/api/app/workflow/brief"],
  ["GET", "/api/app/workflow/brief/templates"],
  ["POST", "/api/app/workflow/brief/templates/saas-activation/apply"],
  ["GET", "/api/app/workflow/brief/versions"],
  ["POST", "/api/app/workflow/brief/versions/version_1/restore"],
  ["GET", "/api/app/workflow/requirements"],
  ["PUT", "/api/app/workflow/requirements"],
  ["GET", "/api/app/workflow/plan-items"],
  ["PUT", "/api/app/workflow/plan-items"],
  ["POST", "/api/app/workflow/plan-items"],
  ["PATCH", "/api/app/workflow/plan-items/item_1"],
  ["GET", "/api/app/workflow/blockers-questions"],
  ["PUT", "/api/app/workflow/blockers-questions"],
  ["GET", "/api/app/workflow/blockers"],
  ["POST", "/api/app/workflow/blockers"],
  ["PATCH", "/api/app/workflow/blockers/blocker_1"],
  ["GET", "/api/app/workflow/questions"],
  ["POST", "/api/app/workflow/questions"],
  ["PATCH", "/api/app/workflow/questions/question_1"],
  ["GET", "/api/app/workflow/validation-evidence"],
  ["PUT", "/api/app/workflow/validation-evidence"],
  ["POST", "/api/app/workflow/validation-evidence"],
  ["PATCH", "/api/app/workflow/validation-evidence/evidence_1"],
  ["GET", "/api/app/workflow/release-confirmation"],
  ["PUT", "/api/app/workflow/release-confirmation"],
  ["POST", "/api/app/workflow/release-confirmation"],
] as const;

test("workflow API route module exposes authenticated endpoint shape", async () => {
  resetStoreForTests();
  const app = new Hono();
  app.route("/api/app/workflow", workflowRoutes);

  for (const [method, path] of workflowEndpoints) {
    const response = await app.request(path, { method });
    const body = await response.json();

    assert.equal(response.status, 401, `${method} ${path}`);
    assert.deepEqual(body, { error: "authentication required" }, `${method} ${path}`);
  }
});
