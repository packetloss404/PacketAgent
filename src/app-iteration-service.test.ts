import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAppIterationToDraft,
  buildAppIterationPlan,
  type GeneratedAppDraftLike,
  normalizeAppIterationRequest,
  selectAppIterationTarget,
} from "./app-iteration-service";

function draftFixture(): GeneratedAppDraftLike {
  return {
    appName: "Launch Task Tracker",
    pageMap: [
      {
        path: "/login",
        name: "Sign in",
        access: "public",
        purpose: "Authenticate users.",
        actions: ["sign in"],
      },
      {
        path: "/tasks",
        name: "Tasks",
        access: "private",
        purpose: "Review launch tasks.",
        primaryEntity: "task",
        actions: ["create task"],
      },
      {
        path: "/reports",
        name: "Reports",
        access: "private",
        purpose: "Review delivery reports.",
        actions: ["export report"],
      },
    ],
    apiRouteStubs: [
      {
        method: "GET",
        path: "/api/app/generated/launch/tasks",
        access: "private",
        purpose: "List tasks.",
        responseShape: "task[]",
      },
    ],
    dataSchema: {
      database: "postgres",
      entities: [
        {
          name: "task",
          primaryKey: "id",
          fields: [
            { name: "id", type: "uuid", required: true },
            { name: "title", type: "string", required: true },
            { name: "status", type: "enum", required: true, enumValues: ["todo", "doing", "done"] },
          ],
          indexes: ["status"],
          relations: [],
        },
      ],
      notes: ["Keep task IDs stable."],
    },
    auth: {
      defaultPolicy: "authenticated-by-default",
      publicRoutes: ["/login"],
      privateRoutes: ["/tasks", "/reports"],
      roleRoutes: [],
      decisions: ["Only sign-in is public."],
    },
    config: {
      env: ["NODE_ENV"],
      featureFlags: { reports: true },
      notes: [],
    },
    acceptanceChecks: ["Tasks render with seed data."],
  };
}

test("buildAppIterationPlan creates deterministic scoped page diff hunks", () => {
  const draft = draftFixture();
  const request = {
    target: { kind: "page" as const, path: "/tasks" },
    change: "Make /tasks show blocked work and add a triage filter.",
  };

  const first = buildAppIterationPlan(draft, request);
  const second = buildAppIterationPlan(draft, request);

  assert.deepEqual(first, second);
  assert.equal(first.version, "phase-69-lane-2");
  assert.equal(first.request.target.kind, "page");
  assert.equal(first.request.target.path, "/tasks");
  assert.equal(first.request.target.exists, true);
  assert.equal(first.diffHunks.length, 1);
  assert.match(first.diffHunks[0].before, /Review launch tasks/);
  assert.match(first.diffHunks[0].after, /triage filter/);
  assert.match(first.rollbackCheckpoint.checkpointId, /^app-iteration-[a-f0-9]{8}-[a-f0-9]{8}$/);
});

test("applyAppIterationToDraft updates a cloned page draft and preserves the original", () => {
  const draft = draftFixture();
  const result = applyAppIterationToDraft(draft, {
    target: { kind: "page", path: "/tasks" },
    change: "Make /tasks public and add a quick-start action.",
  });

  const originalTasks = draft.pageMap?.find((page) => page.path === "/tasks");
  const nextTasks = result.draft.pageMap?.find((page) => page.path === "/tasks");

  assert.equal(result.applied, true);
  assert.equal(originalTasks?.access, "private");
  assert.equal(
    originalTasks?.actions?.includes("Make /tasks public and add a quick-start action"),
    false,
  );
  assert.equal(nextTasks?.access, "public");
  assert.equal(
    nextTasks?.actions?.includes("Make /tasks public and add a quick-start action"),
    true,
  );
  assert.ok(result.plan.risks.some((risk) => risk.code === "access-control"));
  assert.notEqual(result.rollbackCheckpoint.draftHash, result.afterDraftHash);
});

test("API target selection can add a scoped route without touching existing routes", () => {
  const draft = draftFixture();
  const result = applyAppIterationToDraft(draft, {
    target: { kind: "api", path: "/api/app/generated/launch/tasks/export" },
    change: "Add POST /api/app/generated/launch/tasks/export endpoint for task CSV export.",
  });

  assert.equal(result.plan.request.action, "add");
  assert.equal(result.plan.request.target.exists, false);
  assert.equal(result.plan.warnings.length, 0);
  assert.equal(result.draft.apiRouteStubs?.length, 2);
  assert.ok(
    result.draft.apiRouteStubs?.some(
      (route) =>
        route.method === "POST" &&
        route.path === "/api/app/generated/launch/tasks/export" &&
        route.purpose?.includes("CSV export"),
    ),
  );
  assert.ok(
    draft.apiRouteStubs?.every((route) => route.path !== "/api/app/generated/launch/tasks/export"),
  );
});

test("auth changes move routes between generated access buckets", () => {
  const draft = draftFixture();
  const result = applyAppIterationToDraft(draft, {
    target: { kind: "auth", path: "/reports" },
    change: "Make /reports admin only for launch managers.",
  });

  assert.equal(result.plan.request.target.kind, "auth");
  assert.ok(
    result.plan.risks.some((risk) => risk.severity === "high" && risk.code === "access-control"),
  );
  assert.equal(result.draft.auth?.privateRoutes?.includes("/reports"), false);
  assert.equal(result.draft.auth?.publicRoutes?.includes("/reports"), false);
  assert.ok(
    result.draft.auth?.roleRoutes?.some(
      (roleRoute) => roleRoute.role === "admin" && roleRoute.routes.includes("/reports"),
    ),
  );
});

test("data remove requests generate destructive risk and scoped rollback metadata", () => {
  const draft = draftFixture();
  const plan = buildAppIterationPlan(draft, {
    target: { kind: "data", name: "task" },
    change: "Remove task entity after replacing it with milestones.",
  });
  const result = applyAppIterationToDraft(draft, plan);

  assert.equal(plan.request.action, "remove");
  assert.equal(plan.request.target.exists, true);
  assert.deepEqual(
    plan.diffHunks.map((hunk) => hunk.after),
    ["null"],
  );
  assert.ok(plan.warnings.some((warning) => warning.includes("Removal request")));
  assert.ok(plan.risks.some((risk) => risk.code === "destructive-change"));
  assert.ok(plan.risks.some((risk) => risk.code === "data-contract"));
  assert.deepEqual(result.draft.dataSchema?.entities, []);
  assert.equal(result.rollbackCheckpoint.targetKey, "task");
});

test("config iteration warnings redact literal secrets in applied draft metadata", () => {
  const draft = draftFixture();
  const result = applyAppIterationToDraft(draft, {
    target: { kind: "config", name: "stripe checkout" },
    change: "Enable feature flag checkout with STRIPE_SECRET_KEY=sk_live_123.",
  });

  assert.equal(result.plan.request.target.kind, "config");
  assert.ok(result.plan.warnings.some((warning) => warning.includes("literal secret")));
  assert.ok(
    result.plan.risks.some((risk) => risk.code === "configuration" && risk.severity === "high"),
  );
  assert.equal(result.draft.config?.featureFlags?.["stripe-checkout"], true);
  assert.ok(
    result.draft.config?.notes?.some((note) => note.includes("STRIPE_SECRET_KEY=[redacted]")),
  );
  assert.equal(
    result.draft.config?.notes?.some((note) => note.includes("sk_live_123")),
    false,
  );
});

test("config iteration metadata redacts every literal secret in one request", () => {
  const result = applyAppIterationToDraft(draftFixture(), {
    target: { kind: "config", name: "multi-provider setup" },
    change: "Configure OPENAI_API_KEY=sk-openai-secret and STRIPE_SECRET_KEY=sk-stripe-secret.",
  });
  const notes = result.draft.config?.notes?.join(" ") ?? "";

  assert.match(notes, /OPENAI_API_KEY=\[redacted\]/);
  assert.match(notes, /STRIPE_SECRET_KEY=\[redacted\]/);
  assert.doesNotMatch(notes, /sk-openai-secret|sk-stripe-secret/);
});

test("target and request normalization infer stable defaults", () => {
  const draft = draftFixture();

  const target = selectAppIterationTarget(
    draft,
    undefined,
    "Update /api/app/generated/launch/tasks so GET includes overdue counts.",
  );
  const normalized = normalizeAppIterationRequest(draft, {
    change: "Update /api/app/generated/launch/tasks so GET includes overdue counts.",
  });

  assert.equal(target.kind, "api");
  assert.equal(target.path, "/api/app/generated/launch/tasks");
  assert.equal(normalized.draftId, "generated-app-draft");
  assert.equal(normalized.action, "update");
  assert.equal(normalized.target.key, "get:/api/app/generated/launch/tasks");
});
