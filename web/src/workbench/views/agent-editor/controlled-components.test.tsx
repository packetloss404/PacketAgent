import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentPlaybookStep, AgentRecord, AvailableTool } from "@/lib/types";
import { ApprovalPanel } from "./approval-panel";
import { InputSchemaEditor, MemoryEditor, RunInputControl, ToolPicker } from "./contract-editors";
import { Field, Row, Section } from "./layout";
import { PlaybookEditor } from "./playbook";
import { AgentRunSidebar } from "./run-sidebar";

const noop = () => undefined;

test("Agent editor layout and empty controlled editors preserve visible states", () => {
  const layout = renderToStaticMarkup(
    <Section number="01 / 05" kicker="CONFIGURATION" title="Identity">
      <Row>
        <Field label="Name">
          <input defaultValue="Example" />
        </Field>
      </Row>
    </Section>,
  );
  assert.match(layout, /CONFIGURATION/);
  assert.match(layout, /Identity/);
  assert.match(layout, /Name/);

  assert.match(
    renderToStaticMarkup(<PlaybookEditor steps={[]} showValidation={false} onChange={noop} />),
    /empty playbook/,
  );
  assert.match(
    renderToStaticMarkup(<ToolPicker tools={[]} enabled={[]} onChange={noop} />),
    /tool registry empty/,
  );
  assert.match(
    renderToStaticMarkup(<MemoryEditor memory={[]} onChange={noop} />),
    /no saved context/,
  );
  assert.match(
    renderToStaticMarkup(<InputSchemaEditor schema={[]} onChange={noop} />),
    /empty schema/,
  );
});

test("Agent editor playbook, tools, inputs, and approval remain controlled by props", () => {
  const playbook = [
    { id: "step-1", title: "", instruction: "Collect the request" },
  ] as AgentPlaybookStep[];
  const playbookMarkup = renderToStaticMarkup(
    <PlaybookEditor steps={playbook} showValidation={true} onChange={noop} />,
  );
  assert.match(playbookMarkup, /Step 01 needs a title/);
  assert.match(playbookMarkup, /aria-invalid="true"/);

  const tools = [
    { name: "http_fetch", description: "Fetch a URL", side: "read" },
    { name: "email_send", description: "Send email", side: "write" },
  ] as AvailableTool[];
  const toolsMarkup = renderToStaticMarkup(
    <ToolPicker tools={tools} enabled={["http_fetch"]} onChange={noop} />,
  );
  assert.match(toolsMarkup, /READ · 1/);
  assert.match(toolsMarkup, /WRITE · 1/);
  assert.match(toolsMarkup, /checked=""/);

  const inputMarkup = renderToStaticMarkup(
    <RunInputControl
      field={{ key: "mode", label: "Mode", type: "enum", required: true, options: ["safe"] }}
      value="safe"
      onChange={noop}
    />,
  );
  assert.match(inputMarkup, /Mode \*/);
  assert.match(inputMarkup, /selected=""/);

  const approvalMarkup = renderToStaticMarkup(
    <ApprovalPanel
      pending={
        {
          approval: {
            triggerKind: "manual",
            expiresAt: "2030-01-01T00:00:00.000Z",
            summary: "Review exact tools",
            tools: [
              {
                name: "email_send",
                side: "write",
                risk: "medium",
                description: "Send one message",
              },
            ],
          },
          inputs: {},
          triggerKind: "manual",
        } as never
      }
      running={false}
      saving={false}
      canRunAgent={true}
      onLaunch={noop}
      onEditTools={noop}
      onCancel={noop}
    />,
  );
  assert.match(approvalMarkup, /TOOL APPROVAL/);
  assert.match(approvalMarkup, /medium\/write/);
  assert.match(approvalMarkup, /Launch/);
});

test("Agent run sidebar preserves empty launcher and history states", () => {
  const markup = renderToStaticMarkup(
    <AgentRunSidebar
      isNew={false}
      agent={{ id: "agent-1" } as AgentRecord}
      inputSchema={[]}
      runInputs={{}}
      canRunAgent={true}
      canManageAgent={true}
      running={false}
      saving={false}
      firstRunEvaluationPending={true}
      pendingApproval={null}
      runs={[]}
      expandedRun={null}
      playbookReviewRunId={null}
      recordingRunId={null}
      playbook={[]}
      updateRunInputValue={noop}
      runNow={noop}
      launchPendingApproval={noop}
      editPendingTools={noop}
      cancelPendingApproval={noop}
      setExpandedRun={noop}
      setPlaybookReviewRunId={noop}
      recordAsPlaybook={noop}
    />,
  );
  assert.match(markup, /RUN WITH INPUTS/);
  assert.match(markup, /no inputs defined/);
  assert.match(markup, /Evaluate first run/);
  assert.match(markup, /no runs recorded/);
});
