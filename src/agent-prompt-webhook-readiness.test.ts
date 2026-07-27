import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_COOKIE_NAME } from "./auth-utils";
import { app } from "./server";
import {
  generateAgentDraftFromPrompt,
  login,
} from "./packetagent-services";
import { resetStoreForTests } from "./packetagent-store";

function authHeaders(cookieValue: string) {
  return {
    Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`,
    "content-type": "application/json",
  };
}

test("prompt-generated webhook agent drafts expose trigger readiness in the draft and plan", () => {
  const draft = generateAgentDraftFromPrompt(
    "Build an agent that receives incoming webhook payload events from Stripe and routes high priority incidents to support.",
  );

  assert.equal(draft.agent.triggerKind, "webhook");
  assert.equal(draft.readiness.webhook.recommended, true);
  assert.equal(draft.readiness.webhook.tokenRequired, true);
  assert.equal(draft.readiness.webhook.publicTriggerRoute, "/api/public/webhooks/agents/:token");
  assert.ok(draft.plan.some((item) => item.title === "Prepare webhook trigger readiness"));
  assert.ok(draft.assumptions.some((entry) => entry.includes("generated token")));
});

test("agent prompt route returns webhook readiness for dry-run drafts", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const response = await app.request("/api/app/agents/generate-from-prompt", {
    method: "POST",
    headers: authHeaders(auth.cookieValue),
    body: JSON.stringify({
      prompt: "Create an agent for incoming webhook request payloads that validates incident events and alerts the on-call owner.",
    }),
  });
  const body = await response.json() as {
    created: boolean;
    draft: {
      agent: {
        triggerKind: string;
      };
      plan: Array<{
        title: string;
        detail: string;
      }>;
      readiness: {
        webhook: ReturnType<typeof generateAgentDraftFromPrompt>["readiness"]["webhook"];
      };
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.created, false);
  assert.equal(body.draft.agent.triggerKind, "webhook");
  assert.equal(body.draft.readiness.webhook.recommended, true);
  assert.equal(body.draft.readiness.webhook.tokenManagementRoute, "/api/app/webhooks/agents/:agentId/rotate");
  assert.match(body.draft.readiness.webhook.message, /create or rotate its webhook token/);
  assert.ok(body.draft.plan.some((step) => step.title === "Prepare webhook trigger readiness"));
});
