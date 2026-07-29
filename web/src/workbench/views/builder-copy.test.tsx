import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILDER_STARTER_PROMPTS,
  builderPrimaryActionCopy,
  resolveBuilderStartKind,
  shouldRouteToAgentBuilder,
} from "./builder-start";
import {
  getPreviewNavigationTarget,
  publishPrimaryActionLabel,
  publishReadinessHeading,
} from "./builder/helpers";
import { CHECKS, PREVIEW_TRUTH_COPY } from "./preview-copy";

test("preview truth copy stays honest about local-only delivery", () => {
  assert.match(PREVIEW_TRUTH_COPY, /local preview route/i);
  assert.match(PREVIEW_TRUTH_COPY, /not a public deployment/i);
  assert.ok(CHECKS.some((check) => check.label === "Generated source"));
});

test("publish labels describe handoff records instead of hosted deploys", () => {
  assert.equal(publishReadinessHeading(null), "Loading publish handoff");
  assert.equal(publishReadinessHeading({ canPublish: false }), "Publish handoff blocked");
  assert.equal(
    publishReadinessHeading({
      canPublish: true,
      publishedUrl: "http://localhost:8484/app/alpha/crm",
    }),
    "Ready for local publish handoff",
  );
  assert.equal(publishPrimaryActionLabel(false), " Publish");
  assert.equal(publishPrimaryActionLabel(true), " Publishing...");
});

test("preview navigation stays local unless backend provides an absolute URL", () => {
  assert.equal(getPreviewNavigationTarget(null, "app_123"), "/builder/preview/workspace/app_123");
  assert.equal(
    getPreviewNavigationTarget("builder/preview/alpha/app_123", "app_123"),
    "/builder/preview/alpha/app_123",
  );
  assert.equal(
    getPreviewNavigationTarget("/builder/preview/alpha/app_123", "app_123"),
    "/builder/preview/alpha/app_123",
  );
  assert.equal(
    getPreviewNavigationTarget("https://example.test/app", "app_123"),
    "https://example.test/app",
  );
});

test("builder start routing sends explicit agent intent to the agent builder", () => {
  assert.equal(shouldRouteToAgentBuilder("Build an agent that posts a daily standup digest"), true);
  assert.equal(
    shouldRouteToAgentBuilder("Create a webhook agent to triage incidents and post to Slack"),
    true,
  );
  assert.equal(
    resolveBuilderStartKind("I need an AI assistant that summarizes new leads"),
    "agent",
  );
  assert.equal(resolveBuilderStartKind("I need a Slack bot"), "agent");
  assert.equal(resolveBuilderStartKind("Want a daily standup agent"), "agent");
});

test("builder start routing keeps app surfaces on the app builder", () => {
  assert.equal(resolveBuilderStartKind("Build a lightweight CRM for account managers"), "app");
  assert.equal(resolveBuilderStartKind("Build an app for sales agents to manage renewals"), "app");
  assert.equal(resolveBuilderStartKind("Create an agent portal for onboarding brokers"), "app");
});

test("starter prompt modes match their routing and app copy stays unchanged", () => {
  for (const starter of BUILDER_STARTER_PROMPTS) {
    assert.equal(resolveBuilderStartKind(starter.prompt), starter.kind, starter.label);
  }
  assert.equal(builderPrimaryActionCopy("Build a lightweight CRM", false), "Build");
  assert.equal(
    builderPrimaryActionCopy("Build an agent that posts a daily digest", false),
    "Open agent builder",
  );
  assert.equal(
    builderPrimaryActionCopy("Build an agent that posts a daily digest", true),
    "Generating",
  );
});
