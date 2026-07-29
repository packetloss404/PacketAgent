import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { login } from "./packetagent-services";
import { resetStoreForTests, type WorkspaceRole } from "./packetagent-store";
import { workflowRoutes } from "./workflow-routes";
import { ProviderRouter, resetDefaultRouterForTests, setDefaultRouter } from "./providers/router";
import type { LLMProvider, ProviderCallOptions, ProviderCallResult } from "./providers/types";

function createTestApp() {
  const app = new Hono();
  app.route("/api/app/workflow", workflowRoutes);
  return app;
}

function loginAlphaAs(role: WorkspaceRole) {
  const store = resetStoreForTests();
  const membership = store.memberships.find(
    (entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha",
  );
  assert.ok(membership);
  membership.role = role;
  return login({ email: "alpha@packetagent.local", password: "demo12345" });
}

test("workflow routes require authentication", async () => {
  resetStoreForTests();
  const app = createTestApp();

  const response = await app.request("/api/app/workflow/brief");
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: "authentication required" });
});

test("workflow route reports invalid JSON bodies as bad requests", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createTestApp();

  const response = await app.request("/api/app/workflow/brief", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      cookie: `packetagent_session=${auth.cookieValue}`,
    },
    body: "{not json",
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body, { error: "request body must be valid JSON" });
});

test("viewer can read workflow routes", async () => {
  const auth = loginAlphaAs("viewer");
  const app = createTestApp();

  const briefResponse = await app.request("/api/app/workflow/brief", {
    headers: { cookie: `packetagent_session=${auth.cookieValue}` },
  });
  const templatesResponse = await app.request("/api/app/workflow/templates", {
    headers: { cookie: `packetagent_session=${auth.cookieValue}` },
  });

  assert.equal(briefResponse.status, 200);
  assert.equal(templatesResponse.status, 200);
});

test("viewer cannot write workflow routes", async () => {
  const auth = loginAlphaAs("viewer");
  const app = createTestApp();
  const headers = {
    "content-type": "application/json",
    cookie: `packetagent_session=${auth.cookieValue}`,
  };

  const responses = await Promise.all([
    app.request("/api/app/workflow/brief", {
      method: "PUT",
      headers,
      body: JSON.stringify({ summary: "Viewer edit" }),
    }),
    app.request("/api/app/workflow/templates/customer_onboarding_portal/apply", {
      method: "POST",
      headers,
    }),
    app.request("/api/app/workflow/generate-from-prompt", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Draft a workflow" }),
    }),
    app.request("/api/app/workflow/plan-mode", {
      method: "POST",
      headers,
    }),
    app.request("/api/app/workflow/plan-mode/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ planItems: [{ summary: "Viewer plan" }] }),
    }),
  ]);

  for (const response of responses) {
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.deepEqual(body, { error: "workspace role member is required" });
  }
});

test("member can write workflow routes", async () => {
  const auth = loginAlphaAs("member");
  const app = createTestApp();
  const headers = {
    "content-type": "application/json",
    cookie: `packetagent_session=${auth.cookieValue}`,
  };

  const briefResponse = await app.request("/api/app/workflow/brief", {
    method: "PUT",
    headers,
    body: JSON.stringify({ summary: "Member edit" }),
  });
  const applyResponse = await app.request(
    "/api/app/workflow/templates/customer_onboarding_portal/apply",
    {
      method: "POST",
      headers,
    },
  );
  const planApplyResponse = await app.request("/api/app/workflow/plan-mode/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ planItems: [{ summary: "Member plan", status: "doing" }] }),
  });

  assert.equal(briefResponse.status, 200);
  assert.equal(applyResponse.status, 200);
  assert.equal(planApplyResponse.status, 200);
});

test("brief template apply uses the route template id", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createTestApp();

  const response = await app.request("/api/app/workflow/brief/templates/saas-activation/apply", {
    method: "POST",
    headers: { cookie: `packetagent_session=${auth.cookieValue}` },
  });
  const body = (await response.json()) as { summary: string; targetCustomers: string[] };

  assert.equal(response.status, 200);
  assert.equal(
    body.summary,
    "Roll out a guided activation experience that lifts the percentage of new accounts reaching first value within their first session.",
  );
  assert.deepEqual(body.targetCustomers, [
    "Self-serve trial accounts",
    "Pilot customers in the first 30 days",
  ]);
});

test("plan-mode apply filters empty items and normalizes statuses", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createTestApp();

  const response = await app.request("/api/app/workflow/plan-mode/apply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `packetagent_session=${auth.cookieValue}`,
    },
    body: JSON.stringify({
      planItems: [
        { summary: "Draft implementation plan", status: "doing" },
        { summary: "", status: "done" },
        { summary: "Confirm release", status: "done" },
        { summary: "Unknown status falls back", status: "blocked" },
      ],
    }),
  });
  const body = (await response.json()) as { planItems: { title: string; status: string }[] };

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.planItems.map((item) => item.title),
    ["Draft implementation plan", "Confirm release", "Unknown status falls back"],
  );
  assert.deepEqual(
    body.planItems.map((item) => item.status),
    ["in_progress", "done", "todo"],
  );
});

test("generate-from-prompt applies the LLM-shaped draft", async () => {
  resetStoreForTests();
  const router = new ProviderRouter({
    "workflow.draft": { provider: "stub", model: "stub-small" },
  });
  router.register("stub", new JsonDraftProvider());
  setDefaultRouter(router);

  try {
    const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const app = createTestApp();
    const response = await app.request("/api/app/workflow/generate-from-prompt", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `packetagent_session=${auth.cookieValue}`,
      },
      body: JSON.stringify({ prompt: "Build a workflow from this user prompt", apply: true }),
    });
    const body = (await response.json()) as {
      draft: { brief: { summary: string } };
      brief: { summary: string };
    };

    assert.equal(response.status, 200);
    assert.equal(body.draft.brief.summary, "LLM generated workflow summary");
    assert.equal(body.brief.summary, "LLM generated workflow summary");
  } finally {
    resetDefaultRouterForTests();
  }
});

class JsonDraftProvider implements LLMProvider {
  name = "stub" as const;

  async call(_opts: ProviderCallOptions): Promise<ProviderCallResult> {
    return {
      content: JSON.stringify({
        brief: {
          summary: "LLM generated workflow summary",
          problem: "The team needs structured workflow planning.",
          outcome: "The workflow is planned and ready for delivery.",
          customers: ["Product lead"],
          metrics: ["Workflow draft accepted"],
        },
        requirements: [{ summary: "Capture the generated requirement", priority: "must" }],
        planItems: [{ summary: "Implement the generated plan item", status: "todo" }],
      }),
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      model: "stub-small",
      providerName: "stub",
    };
  }

  async *stream(): AsyncIterable<never> {}

  async models(): Promise<string[]> {
    return ["stub-small"];
  }
}
