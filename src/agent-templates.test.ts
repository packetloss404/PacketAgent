import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgent,
  createAgentFromTemplate,
  listAgentTemplates,
  login,
  runAgent,
  updateAgent,
} from "./packetagent-services";
import { AGENT_TEMPLATES } from "./agent-templates.js";
import { resetStoreForTests } from "./packetagent-store";
import { listDefaultToolSummaries } from "./tools/bootstrap.js";

test("agent template catalog exposes built-in templates", () => {
  resetStoreForTests();
  const { templates } = listAgentTemplates();
  assert.ok(templates.length >= 3);
  assert.ok(templates.every((entry) => entry.id && entry.name && Array.isArray(entry.inputSchema)));
});

test("createAgentFromTemplate clones template fields and links templateId", () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const { agent } = createAgentFromTemplate(auth.context, "support_triage");

  assert.equal(agent.templateId, "support_triage");
  assert.equal(agent.name, "Support inbox triage");
  assert.ok(agent.inputSchema.some((field) => field.key === "mailbox"));
  assert.ok(agent.tools.includes("read_workflow_brief"));
  assert.equal(agent.tools.includes("gmail"), false);
});

test("agent templates only expose executable runtime tools or setup-required labels", () => {
  const registered = new Set(listDefaultToolSummaries().map((tool) => tool.name));

  for (const template of AGENT_TEMPLATES) {
    const setupRequired = new Set(template.setupRequiredTools ?? []);
    for (const tool of template.tools) {
      assert.ok(registered.has(tool), `${template.id} references non-runtime tool ${tool}`);
      assert.equal(
        setupRequired.has(tool),
        false,
        `${template.id} duplicates executable tool ${tool} as setup-required`,
      );
    }
    for (const tool of setupRequired) {
      assert.equal(
        registered.has(tool),
        false,
        `${template.id} marks registered tool ${tool} as setup-required`,
      );
    }
  }
});

test("createAgentFromTemplate rejects unknown template", () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  assert.throws(() => createAgentFromTemplate(auth.context, "nope"), /agent template not found/);
});

test("agent input schema is validated and persisted", () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const { agent } = createAgent(auth.context, {
    name: "Schema agent",
    instructions: "Capture typed inputs and validate them.",
    inputSchema: [
      { key: "topic", label: "Topic", type: "string", required: true },
      {
        key: "depth",
        label: "Depth",
        type: "enum",
        required: true,
        options: ["quick", "deep"],
        defaultValue: "quick",
      },
    ],
  });

  assert.equal(agent.inputSchema.length, 2);

  assert.throws(
    () =>
      updateAgent(auth.context, agent.id, {
        inputSchema: [{ key: "bad-key!", label: "Bad", type: "string", required: false }],
      } as any),
    /input field keys must be/,
  );

  assert.throws(
    () =>
      updateAgent(auth.context, agent.id, {
        inputSchema: [{ key: "mode", label: "Mode", type: "enum", required: true, options: [] }],
      } as any),
    /enum field/,
  );
});

test("runAgent validates required inputs and records logs", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const { agent } = createAgentFromTemplate(auth.context, "release_audit");

  await assert.rejects(
    () => runAgent(auth.context, agent.id, { inputs: {} }),
    /input release_label is required/,
  );

  const { run } = await runAgent(auth.context, agent.id, {
    inputs: { release_label: "v1.2.3", evidence_url: "https://example.com/evidence" },
  });

  assert.equal(run.status, "success");
  assert.match(run.title, /dry run recorded/);
  assert.equal(run.inputs?.release_label, "v1.2.3");
  assert.equal(run.inputs?.evidence_url, "https://example.com/evidence");
  assert.match(run.output ?? "", /did not call a model, external provider, or runtime tools/i);
  assert.ok((run.logs ?? []).length >= 2);
  assert.ok(
    (run.logs ?? []).some((entry: { message: string }) => entry.message.includes("release_label")),
  );
  assert.ok(
    (run.logs ?? []).some((entry: { message: string }) =>
      entry.message.includes("No model or runtime tools were invoked"),
    ),
  );
});

test("runAgent rejects invalid url and enum inputs", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const { agent } = createAgentFromTemplate(auth.context, "release_audit");

  await assert.rejects(
    () =>
      runAgent(auth.context, agent.id, {
        inputs: { release_label: "v1", evidence_url: "not-a-url" },
      }),
    /must be a valid http/,
  );

  const { agent: triage } = createAgentFromTemplate(auth.context, "support_triage");
  await assert.rejects(
    () =>
      runAgent(auth.context, triage.id, {
        inputs: { mailbox: "inbox", urgency_threshold: "extreme" },
      }),
    /must be one of/,
  );
});
