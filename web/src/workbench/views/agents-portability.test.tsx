import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentBundleImportPreview } from "@/lib/types";
import { AgentImportDialog } from "./agents";

test("Agent import review exposes the paused boundary and gates an unconfigured publisher", () => {
  const markup = renderToStaticMarkup(
    <AgentImportDialog
      preview={preview("untrusted")}
      error={null}
      busy={false}
      acknowledgePublisher={false}
      onAcknowledgePublisher={() => undefined}
      onImport={() => undefined}
      onClose={() => undefined}
    />,
  );

  assert.match(markup, /Import Portable reviewer/);
  assert.match(markup, /paused/);
  assert.match(markup, /draft projection/);
  assert.match(markup, /signature verified · untrusted/);
  assert.match(markup, /Credentials, webhook tokens, run history, and active/);
  assert.match(markup, /acknowledge the unconfigured/);
  assert.match(markup, /Import paused agent/);
  assert.match(markup, /disabled=""/);
});

test("a locally signed Agent import does not ask for publisher acknowledgement", () => {
  const markup = renderToStaticMarkup(
    <AgentImportDialog
      preview={preview("local")}
      error={null}
      busy={false}
      acknowledgePublisher={false}
      onAcknowledgePublisher={() => undefined}
      onImport={() => undefined}
      onClose={() => undefined}
    />,
  );

  assert.match(markup, /signature verified · local/);
  assert.doesNotMatch(markup, /acknowledge the unconfigured/);
  assert.doesNotMatch(markup, /type="checkbox"/);
});

function preview(trust: AgentBundleImportPreview["publisher"]["trust"]): AgentBundleImportPreview {
  return {
    schemaVersion: "packetagent.agent-worker-bundle/v1",
    bundleDigest: `sha256:${"1".repeat(64)}`,
    agent: {
      name: "Portable reviewer",
      triggerKind: "schedule",
      schedule: "0 9 * * 1",
      toolCount: 1,
      inputCount: 1,
    },
    worker: {
      contentDigest: `sha256:${"2".repeat(64)}`,
      status: "draft",
    },
    publisher: {
      keyId: `sha256:${"3".repeat(64)}`,
      trust,
      signatureVerified: true,
      acknowledgementRequired: trust === "untrusted",
    },
    readiness: {
      provider: {
        status: "needs_setup",
        hint: {
          kind: "openai",
          name: "Source OpenAI",
        },
      },
      missingTools: [],
    },
    importPolicy: {
      status: "paused",
      credentialsIncluded: false,
      webhookTokenIncluded: false,
      runHistoryIncluded: false,
      localIdsIncluded: false,
    },
  };
}
