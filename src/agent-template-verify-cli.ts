import type {
  AgentRecord,
  AgentTriggerKind,
  AgentInputField,
  AgentPlaybookStep,
} from "./packetagent-store.js";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderStreamChunk,
} from "./providers/types.js";
import { generateAgentTemplateViaLlm } from "./agent-builder/llm-template.js";
import { projectLegacyAgentToWorker } from "./workers/projections.js";
import { validateWorkerVersionContent } from "./workers/validation.js";

const authoringSecret = "authorization=agent-template-verifier-secret";
const templatePayload = {
  category: "research",
  name: "Evidence briefing agent",
  summary: "Reads one source and prepares one bounded evidence briefing.",
  description: "Reviews one public source and stops after reporting its findings and risks.",
  instructions: `Read only the supplied source. Never copy ${authoringSecret}. Report findings, risks, and the next action, then stop.`,
  tools: ["http_fetch", "unregistered_mutator"],
  triggerKind: "manual",
  schedule: "",
  inputSchema: [
    {
      key: "source_url",
      label: "Source URL",
      type: "url",
      required: true,
      description: "Public evidence URL.",
      options: [],
      defaultValue: "https://example.com/evidence",
    },
  ],
  playbook: [
    { title: "Read evidence", instruction: "Read the supplied public source." },
    {
      title: "Report",
      instruction: "Return findings, unresolved risks, and the next action, then stop.",
    },
  ],
  acceptanceChecks: ["The report identifies its source and unresolved risks."],
  openQuestions: ["Should a later version compare multiple sources?"],
};

let capturedCall: ProviderCallOptions | undefined;
const provider = fakeProvider(async (options) => {
  capturedCall = options;
  return providerResponse(JSON.stringify(templatePayload));
});
const generated = await generateAgentTemplateViaLlm(
  {
    prompt: "Build a manual research agent that reads one evidence URL and reports risks.",
    workspaceId: "agent-template-verifier",
    allowedTools: ["http_fetch", "email_send"],
    recommendedTools: ["http_fetch"],
    triggerKind: "manual",
  },
  { provider, model: "agent-template-verifier-model" },
);
check(generated.source === "llm", "The valid AgentTemplate did not pass authoring validation.");

const projected = projectLegacyAgentToWorker(
  agentRecord({
    name: generated.template.name,
    description: generated.template.description,
    instructions: generated.template.instructions,
    tools: [...generated.template.tools],
    enabledTools: [...generated.template.tools],
    triggerKind: generated.template.triggerKind,
    inputSchema: generated.template.inputSchema.map((field) => ({
      ...field,
      ...(field.options ? { options: [...field.options] } : {}),
    })),
    playbook: generated.template.playbook.map((step) => ({ ...step })),
  }),
);
const workerValidation = validateWorkerVersionContent(projected.version.content);

const substitutedTrigger = await generateAgentTemplateViaLlm(
  {
    prompt: "Build a manual research agent that reads one evidence URL and reports risks.",
    workspaceId: "agent-template-verifier",
    allowedTools: ["http_fetch"],
    recommendedTools: ["http_fetch"],
    triggerKind: "manual",
  },
  {
    provider: fakeProvider(async () =>
      providerResponse(JSON.stringify({ ...templatePayload, triggerKind: "webhook" })),
    ),
    model: "agent-template-verifier-model",
  },
);

const assertions = {
  structuredSchemaRequested:
    capturedCall?.structuredOutput?.strict === true &&
    capturedCall.structuredOutput.name === "packetagent_agent_template",
  registeredToolsOnly:
    generated.template.tools.length === 1 && generated.template.tools[0] === "http_fetch",
  sensitiveTextRedacted:
    generated.template.instructions.includes("[redacted]") &&
    !generated.template.instructions.includes(authoringSecret),
  deterministicTriggerPreserved:
    generated.template.triggerKind === "manual" && generated.template.schedule === undefined,
  unsafeTriggerSubstitutionRejected:
    substitutedTrigger.source === "heuristic" &&
    substitutedTrigger.fallbackReason === "invalid_output",
  canonicalWorkerProjectionValid:
    workerValidation.ok &&
    projected.version.status === "draft" &&
    projected.version.source.kind === "legacy_agent",
  projectionRequiresLifecycleValidation: projected.warnings.some(
    (warning) => warning.code === "projection.requires_validation",
  ),
};
const result = {
  ok: Object.values(assertions).every(Boolean),
  assertions,
  authoring: {
    source: generated.source,
    provider: generated.provider,
    model: generated.model,
    category: generated.template.category,
  },
  workerProjection: {
    status: projected.version.status,
    sourceKind: projected.version.source.kind,
    warningCodes: projected.warnings.map((warning) => warning.code),
  },
};
const serialized = JSON.stringify(result, null, 2);
check(!serialized.includes(authoringSecret), "AgentTemplate verifier output exposed a secret.");
process.stdout.write(`${serialized}\n`);
if (!result.ok) process.exitCode = 1;

function agentRecord(input: {
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  enabledTools: string[];
  triggerKind: AgentTriggerKind;
  inputSchema: AgentInputField[];
  playbook: AgentPlaybookStep[];
}): AgentRecord {
  return {
    id: "agent-template-verifier-agent",
    workspaceId: "agent-template-verifier",
    status: "active",
    createdByUserId: "agent-template-verifier",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    ...input,
  };
}

function fakeProvider(
  call: (options: ProviderCallOptions) => Promise<ProviderCallResult>,
): LLMProvider {
  return {
    name: "openai",
    call,
    async *stream(): AsyncIterable<ProviderStreamChunk> {
      yield { done: true };
    },
    async models() {
      return ["agent-template-verifier-model"];
    },
  };
}

function providerResponse(content: string): ProviderCallResult {
  return {
    content,
    finishReason: "stop",
    usage: { promptTokens: 100, completionTokens: 200, costUsd: 0.001 },
    providerName: "openai",
    model: "agent-template-verifier-model",
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
