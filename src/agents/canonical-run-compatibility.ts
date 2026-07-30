import {
  loadStoreAsync,
  mutateStoreAsync,
  upsertAgentRun,
  type AgentRunLogEntry,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentRunStep,
  type AgentRunToolCall,
  type AgentTriggerKind,
  type AgentRecord,
} from "../packetagent-store.js";
import { redactSensitiveString, redactSensitiveValue } from "../security/redaction.js";
import type { WorkerEvent } from "../workers/persistence-types.js";
import type { JsonObject, WorkerRun, WorkerVersion } from "../workers/types.js";

export async function refreshLegacyAgentRunFromCanonical(
  workspaceId: string,
  workerRunId: string,
): Promise<AgentRunRecord | null> {
  const snapshot = await loadStoreAsync();
  const run = snapshot.workerRuns.find(
    (entry) => entry.workspaceId === workspaceId && entry.id === workerRunId,
  );
  if (!run) return null;
  const version = snapshot.workerVersions.find(
    (entry) =>
      entry.workspaceId === workspaceId &&
      entry.id === run.workerVersionId &&
      entry.source.kind === "legacy_agent" &&
      typeof entry.source.sourceId === "string",
  );
  if (!version?.source.sourceId) return null;
  const agent = snapshot.agents.find(
    (entry) =>
      entry.workspaceId === workspaceId &&
      entry.id === version.source.sourceId &&
      entry.status !== "archived",
  );
  if (!agent) return null;
  const events = snapshot.workerEvents
    .filter(
      (entry) =>
        entry.workspaceId === workspaceId && "workerRunId" in entry && entry.workerRunId === run.id,
    )
    .sort((left, right) => left.sequence - right.sequence);
  const next = compatibilityRecord(
    snapshot.agentRuns.find(
      (entry) =>
        entry.workspaceId === workspaceId && (entry.workerRunId === run.id || entry.id === run.id),
    ),
    agent,
    run,
    version,
    events,
  );
  return await mutateStoreAsync((data) => upsertAgentRun(data, next, next.updatedAt));
}

function compatibilityRecord(
  previous: AgentRunRecord | undefined,
  agent: AgentRecord,
  run: WorkerRun,
  version: WorkerVersion,
  events: readonly WorkerEvent[],
): AgentRunRecord {
  const status = compatibilityStatus(run.status);
  const completedAt =
    status === "success" || status === "failed" || status === "canceled"
      ? (run.completedAt ?? run.updatedAt)
      : undefined;
  const toolCalls = compatibilityToolCalls(events);
  const providerEvents = events.filter((entry) => entry.type === "worker.provider.completed");
  const costUsd = providerEvents.reduce(
    (total, event) => total + (typeof event.data?.costUsd === "number" ? event.data.costUsd : 0),
    0,
  );
  const modelUsed = lastProviderModel(providerEvents);
  return {
    ...(previous ?? {
      id: run.id,
      workspaceId: run.workspaceId,
      logs: [],
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }),
    id: previous?.id ?? run.id,
    workspaceId: run.workspaceId,
    agentId: agent.id,
    workerDefinitionId: run.workerDefinitionId,
    workerVersionId: run.workerVersionId,
    workerDeploymentId: run.workerDeploymentId,
    workerRunId: run.id,
    title: compatibilityTitle(agent.name, status),
    status,
    triggerKind: compatibilityTriggerKind(run, version),
    ...(run.input ? { inputs: primitiveInputs(run.input) } : {}),
    ...(run.output !== undefined ? { output: outputText(run.output) } : {}),
    ...(run.error ? { error: redactSensitiveString(run.error) } : {}),
    logs: compatibilityLogs(events),
    ...(agent.playbook?.length ? { transcript: compatibilityTranscript(agent.playbook, run) } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(modelUsed ? { modelUsed } : {}),
    ...(providerEvents.length ? { costUsd } : {}),
    startedAt: run.startedAt ?? run.createdAt,
    ...(completedAt ? { completedAt } : {}),
    createdAt: previous?.createdAt ?? run.createdAt,
    updatedAt: run.updatedAt,
    ...(previous?.evaluation ? { evaluation: previous.evaluation } : {}),
  };
}

function compatibilityTranscript(
  playbook: NonNullable<AgentRecord["playbook"]>,
  run: WorkerRun,
): AgentRunStep[] {
  const durationMs =
    run.completedAt && run.startedAt
      ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt))
      : 0;
  return playbook.map((step, index) => ({
    id: `${run.id}:playbook:${step.id}`,
    title: step.title,
    status:
      run.status === "completed"
        ? "success"
        : run.status === "failed" ||
            run.status === "budget_exhausted" ||
            run.status === "quarantined"
          ? index === 0
            ? "failed"
            : "skipped"
          : run.status === "cancelled"
            ? "skipped"
            : "skipped",
    output:
      run.status === "completed"
        ? "Completed by the canonical Worker runtime."
        : run.error
          ? redactSensitiveString(run.error)
          : "Pending canonical Worker execution.",
    durationMs: index === 0 ? durationMs : 0,
    startedAt: run.startedAt ?? run.createdAt,
  }));
}

function lastProviderModel(events: readonly WorkerEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const model = events[index].data?.model;
    if (typeof model === "string") return model;
  }
  return undefined;
}

function compatibilityStatus(status: WorkerRun["status"]): AgentRunStatus {
  if (status === "completed") return "success";
  if (status === "cancelled") return "canceled";
  if (status === "failed" || status === "budget_exhausted" || status === "quarantined") {
    return "failed";
  }
  if (status === "running") return "running";
  return "queued";
}

function compatibilityTitle(agentName: string, status: AgentRunStatus): string {
  if (status === "success") return `${agentName} run completed`;
  if (status === "failed") return `${agentName} run failed`;
  if (status === "canceled") return `${agentName} run canceled`;
  if (status === "running") return `${agentName} run in progress`;
  return `${agentName} run queued`;
}

function compatibilityTriggerKind(run: WorkerRun, version: WorkerVersion): AgentTriggerKind {
  if (run.triggerKind === "cron") return "schedule";
  if (run.triggerKind === "webhook") {
    const trigger = version.content.triggers.find((entry) => entry.id === run.triggerId);
    return trigger?.kind === "webhook" && trigger.adapter === "email" ? "email" : "webhook";
  }
  return "manual";
}

function primitiveInputs(input: JsonObject): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
}

function outputText(value: unknown): string {
  const redacted = redactSensitiveValue(value);
  return typeof redacted === "string" ? redactSensitiveString(redacted) : JSON.stringify(redacted);
}

function compatibilityLogs(events: readonly WorkerEvent[]): AgentRunLogEntry[] {
  return events.map((event) => ({
    at: event.occurredAt,
    level: event.type.includes("failed")
      ? "error"
      : event.type.includes("attention") || event.type.includes("denied")
        ? "warn"
        : "info",
    message: redactSensitiveString(event.summary),
  }));
}

function compatibilityToolCalls(events: readonly WorkerEvent[]): AgentRunToolCall[] {
  return events.flatMap((event) => {
    if (event.type !== "worker.tool.completed" && event.type !== "worker.tool.failed") {
      return [];
    }
    const callId = event.data?.callId;
    const tool = event.data?.tool;
    if (typeof callId !== "string" || typeof tool !== "string") return [];
    const durationMs = typeof event.data?.durationMs === "number" ? event.data.durationMs : 0;
    const failed = event.type === "worker.tool.failed";
    return [
      {
        id: callId,
        toolName: tool,
        input: {},
        ...(failed ? { error: "Canonical Worker tool call failed." } : {}),
        durationMs,
        startedAt: new Date(Math.max(0, Date.parse(event.occurredAt) - durationMs)).toISOString(),
        completedAt: event.occurredAt,
        status: failed ? ("error" as const) : ("ok" as const),
      },
    ];
  });
}
