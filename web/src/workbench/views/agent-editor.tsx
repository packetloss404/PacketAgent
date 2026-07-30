import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { I } from "../icons";
import { Topbar } from "../Shell";
import { useWorkbench } from "../workbench-state";
import { api } from "@/lib/api";
import {
  describeNextRun,
  triggerLabel,
  TRIGGER_KINDS,
  validateCronSchedule,
  formatDuration,
} from "@/lib/agent-runtime";
import { canEditWorkflowRole, canManageWorkspaceRole } from "@/lib/roles";
import type {
  AgentInputField,
  AgentInputFieldType,
  AgentMemoryEntry,
  AgentPlaybookStep,
  AgentRecord,
  AgentRunRecord,
  AgentRunStep,
  AgentRunStepStatus,
  AgentRunToolCall,
  AgentStatus,
  AgentTriggerKind,
  AvailableTool,
  ProviderRecord,
  RunAgentResponse,
  SaveAgentInput,
  ToolCapabilityApprovalRequest,
  ToolCapabilityApprovalTool,
  ToolCapabilityRisk,
} from "@/lib/types";

const FIELD_TYPES: AgentInputFieldType[] = ["string", "number", "boolean", "url", "enum"];

type RunInputPayload = Record<string, string | number | boolean>;
type ToolRisk = ToolCapabilityRisk;

interface PendingRunApproval {
  approval: ToolCapabilityApprovalRequest;
  inputs: RunInputPayload;
  triggerKind: AgentTriggerKind;
  evaluation?: { kind: "first_run" };
}

type RunAgentResult = RunAgentResponse;

function webhookOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

export function AgentEditorView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const role = useWorkbench().session.workspace.role;
  const isNew = !id;
  const canManageAgent = canManageWorkspaceRole(role);
  const canRunAgent = canEditWorkflowRole(role);

  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [playbook, setPlaybook] = useState<AgentPlaybookStep[]>([]);
  const [triggerKind, setTriggerKind] = useState<AgentTriggerKind>("manual");
  const [schedule, setSchedule] = useState("");
  const [inputSchema, setInputSchema] = useState<AgentInputField[]>([]);
  const [memory, setMemory] = useState<AgentMemoryEntry[]>([]);
  const [evaluationExpectedOutput, setEvaluationExpectedOutput] = useState("");
  const [evaluationTools, setEvaluationTools] = useState<string[]>([]);
  const [enabledTools, setEnabledTools] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<AvailableTool[]>([]);
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [recordingRunId, setRecordingRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingRunApproval | null>(null);
  const [playbookValidationVisible, setPlaybookValidationVisible] = useState(false);
  const [playbookReviewRunId, setPlaybookReviewRunId] = useState<string | null>(null);
  const toolSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      setPendingApproval(null);
      setPlaybookValidationVisible(false);
      setPlaybookReviewRunId(null);
      try {
        const [providerList, detail, tools] = await Promise.all([
          api.listProviders(),
          id ? api.getAgent(id) : Promise.resolve(null),
          api.listTools().catch(() => [] as AvailableTool[]),
        ]);
        if (!mounted) return;
        setProviders(providerList);
        setAvailableTools(tools);
        if (detail) {
          setAgent(detail.agent);
          setRuns(detail.runs);
          setPlaybook(detail.agent.playbook ?? []);
          setTriggerKind(detail.agent.triggerKind ?? "manual");
          setSchedule(detail.agent.schedule ?? "");
          setExpandedRun(detail.runs[0]?.id ?? null);
          setInputSchema(detail.agent.inputSchema ?? []);
          setMemory(detail.agent.memory ?? []);
          setEvaluationExpectedOutput(detail.agent.evaluationSpec?.expectedOutput ?? "");
          setEvaluationTools(detail.agent.evaluationSpec?.requiredTools ?? []);
          setEnabledTools(detail.agent.enabledTools ?? []);
          setRunInputs(seedRunInputs(detail.agent.inputSchema ?? []));
        }
      } catch (loadError) {
        if (mounted) setError((loadError as Error).message);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [id]);

  const defaults = useMemo<SaveAgentInput>(
    () => ({
      name: agent?.name ?? "",
      description: agent?.description ?? "",
      instructions: agent?.instructions ?? "",
      providerId: agent?.providerId ?? providers[0]?.id ?? "",
      model: agent?.model ?? providers[0]?.defaultModel ?? "",
      tools: agent?.tools ?? [],
      schedule: agent?.schedule ?? "",
      triggerKind: agent?.triggerKind ?? "manual",
      playbook: agent?.playbook ?? [],
      status: agent?.status ?? "active",
    }),
    [agent, providers],
  );

  const nextRunLabel = useMemo(
    () => describeNextRun(schedule, triggerKind),
    [schedule, triggerKind],
  );
  const firstRunEvaluationPending = !runs.some((run) => run.evaluation?.kind === "first_run");
  const scheduleValidation = triggerKind === "schedule" ? validateCronSchedule(schedule) : null;
  const showScheduleValidation =
    triggerKind === "schedule" && scheduleValidation && scheduleTouched;

  const saveAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManageAgent) {
      setError("admin role is required to save agents");
      setMessage(null);
      return;
    }
    const invalidEnum = inputSchema.find(
      (f) => f.type === "enum" && (f.options ?? []).length === 0,
    );
    if (invalidEnum) {
      setError(`enum input ${invalidEnum.key || invalidEnum.label} needs at least one option`);
      setMessage(null);
      return;
    }
    const missingPlaybookTitles = missingPlaybookTitleIndexes(playbook);
    if (missingPlaybookTitles.length > 0) {
      setPlaybookValidationVisible(true);
      setError(
        missingPlaybookTitles.length === 1
          ? `Playbook step ${formatStepList(missingPlaybookTitles)} needs a title before saving. Add a title or remove the step.`
          : `Playbook steps ${formatStepList(missingPlaybookTitles)} need titles before saving. Add titles or remove those steps.`,
      );
      setMessage(null);
      return;
    }
    const form = new FormData(event.currentTarget);
    const body: SaveAgentInput = {
      name: fieldValue(form, "name"),
      description: fieldValue(form, "description"),
      instructions: fieldValue(form, "instructions"),
      providerId: fieldValue(form, "providerId") || undefined,
      model: fieldValue(form, "model") || undefined,
      tools: fieldValue(form, "tools")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      schedule: fieldValue(form, "schedule") || undefined,
      triggerKind,
      playbook: playbook.map((step) => ({
        ...step,
        title: step.title.trim(),
        instruction: step.instruction.trim(),
      })),
      status: fieldValue(form, "status") as AgentStatus,
      inputSchema,
      enabledTools,
      memory,
      evaluationSpec: {
        expectedOutput: evaluationExpectedOutput,
        requiredTools: evaluationTools,
      },
    };

    if (scheduleValidation) {
      setScheduleTouched(true);
      setError(scheduleValidation);
      setMessage(null);
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    setPlaybookValidationVisible(false);
    try {
      const nextAgent = isNew ? await api.createAgent(body) : await api.updateAgent(id!, body);
      setAgent(nextAgent);
      setPlaybook(nextAgent.playbook ?? []);
      setTriggerKind(nextAgent.triggerKind ?? "manual");
      setSchedule(nextAgent.schedule ?? "");
      setInputSchema(nextAgent.inputSchema ?? []);
      setEnabledTools(nextAgent.enabledTools ?? []);
      setMemory(nextAgent.memory ?? []);
      setEvaluationExpectedOutput(nextAgent.evaluationSpec?.expectedOutput ?? "");
      setEvaluationTools(nextAgent.evaluationSpec?.requiredTools ?? []);
      setRunInputs(seedRunInputs(nextAgent.inputSchema ?? []));
      setPendingApproval(null);
      setPlaybookReviewRunId(null);
      setMessage(isNew ? "Agent created." : "Agent saved.");
      if (isNew) navigate(`/agents/${nextAgent.id}`, { replace: true });
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!agent || !canManageAgent) return;
    setSaving(true);
    setError(null);
    try {
      await api.archiveAgent(agent.id);
      navigate("/agents", { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const exportBundle = async () => {
    if (!agent || !canManageAgent) return;
    setExporting(true);
    setError(null);
    setMessage(null);
    try {
      const exported = await api.downloadAgentBundle(agent.id);
      const url = URL.createObjectURL(exported.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.fileName;
      link.click();
      URL.revokeObjectURL(url);
      setMessage("Signed Agent–Worker bundle exported.");
    } catch (exportError) {
      setError((exportError as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const rotateWebhook = async () => {
    if (!agent || !canManageAgent) return;
    setWebhookBusy(true);
    setError(null);
    try {
      const token = await api.rotateAgentWebhook(agent.id);
      setAgent({
        ...agent,
        webhookToken: token,
        webhookTokenPreview: undefined,
        hasWebhookToken: true,
      });
      setMessage("Webhook token rotated. Full URL is shown until this page refreshes.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWebhookBusy(false);
    }
  };

  const removeWebhook = async () => {
    if (!agent || !canManageAgent) return;
    setWebhookBusy(true);
    setError(null);
    try {
      await api.removeAgentWebhook(agent.id);
      setAgent({
        ...agent,
        webhookToken: undefined,
        webhookTokenPreview: undefined,
        hasWebhookToken: false,
      });
      setMessage("Webhook removed.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWebhookBusy(false);
    }
  };

  const recordAsPlaybook = async (runId: string) => {
    if (!canManageAgent) {
      setError("admin role is required to replace an agent playbook");
      setMessage(null);
      return;
    }
    setRecordingRunId(runId);
    setError(null);
    try {
      const updated = await api.recordRunAsPlaybook(runId);
      setAgent(updated);
      setPlaybook(updated.playbook ?? []);
      setPlaybookValidationVisible(false);
      setPlaybookReviewRunId(null);
      setMessage("Run captured as playbook.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRecordingRunId(null);
    }
  };

  const updateEnabledTools = (next: string[]) => {
    setEnabledTools(next);
    setEvaluationTools((current) => current.filter((tool) => next.includes(tool)));
    if (pendingApproval) {
      setPendingApproval(null);
      setError(null);
      setMessage("Enabled tools changed. Save the agent, then execute again.");
    }
  };

  const clearPendingApprovalForRunConfigChange = () => {
    if (!pendingApproval) return;
    setPendingApproval(null);
    setError(null);
    setMessage("Run inputs changed. Execute again to refresh tool approval.");
  };

  const updateRunInputValue = (key: string, next: string) => {
    setRunInputs((prev) => ({ ...prev, [key]: next }));
    clearPendingApprovalForRunConfigChange();
  };

  const updateInputSchema = (next: AgentInputField[]) => {
    setInputSchema(next);
    clearPendingApprovalForRunConfigChange();
  };

  const updateTriggerKind = (next: AgentTriggerKind) => {
    setTriggerKind(next);
    clearPendingApprovalForRunConfigChange();
  };

  const completeRunRequest = async (
    agentId: string,
    result: RunAgentResult,
    inputs: RunInputPayload,
    requestTriggerKind: AgentTriggerKind,
    approvalMessage: string,
    successMessage: string,
    evaluation?: { kind: "first_run" },
  ) => {
    if (isApprovalResult(result)) {
      setPendingApproval({
        approval: result.approval,
        inputs,
        triggerKind: result.approval.triggerKind ?? requestTriggerKind,
        evaluation,
      });
      setMessage(approvalMessage);
      return;
    }

    const newRun = runFromAgentResult(result);
    if (!newRun) throw new Error("Run response did not include a run or approval request.");

    const detail = await api.getAgent(agentId);
    setAgent(detail.agent);
    setRuns(detail.runs);
    setExpandedRun(newRun.id);
    setPendingApproval(null);
    setMessage(successMessage);
  };

  const runNow = async () => {
    if (!agent || !canRunAgent) return;
    const requestTriggerKind: AgentTriggerKind = "manual";
    setRunning(true);
    setError(null);
    setMessage(null);
    setPendingApproval(null);
    try {
      const inputs = buildRunInputPayload(inputSchema, runInputs);
      const evaluation = firstRunEvaluationPending ? ({ kind: "first_run" } as const) : undefined;
      const result = await api.runAgent(agent.id, {
        triggerKind: requestTriggerKind,
        inputs,
        evaluation,
      });
      await completeRunRequest(
        agent.id,
        result,
        inputs,
        requestTriggerKind,
        "Tool approval required before launch.",
        evaluation ? "First-run evaluation recorded." : "Agent run recorded.",
        evaluation,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const launchPendingApproval = async () => {
    if (!agent || !canRunAgent || !pendingApproval) return;
    const pending = pendingApproval;
    setRunning(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.runAgent(agent.id, {
        triggerKind: pending.triggerKind,
        inputs: pending.inputs,
        evaluation: pending.evaluation,
        toolApproval: {
          decision: "launch",
          token: pending.approval.approvalToken,
          approvedTools: pending.approval.tools.map((tool) => tool.name),
        },
      });
      await completeRunRequest(
        agent.id,
        result,
        pending.inputs,
        pending.triggerKind,
        "Tool approval was refreshed. Review the updated request before launching.",
        pending.evaluation ? "First-run evaluation recorded." : "Agent run launched.",
        pending.evaluation,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const editPendingTools = () => {
    setError(null);
    toolSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      toolSectionRef.current?.querySelector<HTMLInputElement>("input[type='checkbox']")?.focus();
    }, 250);
    setMessage(
      canManageAgent
        ? "Adjust enabled tools in the registry, save the agent, then execute again."
        : "Admin role required to adjust enabled tools.",
    );
  };

  const cancelPendingApproval = () => {
    setPendingApproval(null);
    setError(null);
    setMessage("Tool approval canceled.");
  };

  const updatePlaybook = (next: AgentPlaybookStep[]) => {
    setPlaybook(next);
    if (missingPlaybookTitleIndexes(next).length === 0) setPlaybookValidationVisible(false);
  };

  const webhookPathToken = agent?.webhookToken ?? agent?.webhookTokenPreview;
  const hasWebhook = Boolean(
    agent?.webhookToken || agent?.webhookTokenPreview || agent?.hasWebhookToken,
  );

  return (
    <>
      <Topbar
        crumbs={["__WS__", "Agents", isNew ? "New" : (agent?.name ?? "Edit")]}
        actions={
          !isNew && agent ? (
            <>
              <button
                type="button"
                className="top-btn"
                onClick={() => {
                  void runNow();
                }}
                disabled={!canRunAgent || running || saving}
              >
                {running ? (
                  <span className="spin">
                    <I.refresh size={13} />
                  </span>
                ) : (
                  <I.play size={13} />
                )}{" "}
                {firstRunEvaluationPending ? "Evaluate first run" : "Run now"}
              </button>
              {canManageAgent && (
                <button
                  type="button"
                  className="top-btn"
                  onClick={() => {
                    void exportBundle();
                  }}
                  disabled={saving || exporting}
                >
                  <I.download size={13} /> {exporting ? "Exporting…" : "Export"}
                </button>
              )}
              {canManageAgent && (
                <button
                  type="button"
                  className="top-btn"
                  onClick={() => {
                    void archive();
                  }}
                  disabled={saving}
                >
                  <I.trash size={13} /> Archive
                </button>
              )}
            </>
          ) : null
        }
      />

      <div style={{ padding: "26px 28px 60px", maxWidth: 1280 }}>
        {loading && (
          <div className="muted" style={{ padding: 16 }}>
            Loading agent…
          </div>
        )}

        {!loading && !canManageAgent && (
          <div
            className="card"
            style={{ padding: "10px 14px", marginBottom: 14, borderColor: "var(--line-2)" }}
          >
            <span className="mono muted" style={{ fontSize: 11 }}>
              Admin role required to create, edit, archive, or manage webhooks for agents.
            </span>
          </div>
        )}

        {error && (
          <div
            className="card"
            style={{
              padding: "10px 14px",
              marginBottom: 14,
              borderColor: "rgba(242,107,92,0.3)",
              background: "rgba(242,107,92,0.06)",
              color: "var(--danger)",
            }}
          >
            <span className="mono" style={{ fontSize: 11.5 }}>
              ERR · {error}
            </span>
          </div>
        )}
        {message && !error && (
          <div
            className="card"
            style={{
              padding: "10px 14px",
              marginBottom: 14,
              borderColor: "rgba(184,242,92,0.3)",
              background: "rgba(184,242,92,0.06)",
              color: "var(--green)",
            }}
          >
            <span className="mono" style={{ fontSize: 11.5 }}>
              OK · {message}
            </span>
          </div>
        )}

        {!loading && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
              gap: 24,
              alignItems: "start",
            }}
          >
            <form onSubmit={saveAgent}>
              <fieldset disabled={!canManageAgent} style={{ border: 0, padding: 0, margin: 0 }}>
                <Section number="01 / 05" kicker="CONFIGURATION" title="Identity & instructions">
                  <Row>
                    <Field label="Name">
                      <input name="name" defaultValue={defaults.name} className="field" required />
                    </Field>
                    <Field label="Status">
                      <select name="status" defaultValue={defaults.status} className="field">
                        <option value="active">active</option>
                        <option value="paused">paused</option>
                      </select>
                    </Field>
                  </Row>
                  <Field label="Description">
                    <input
                      name="description"
                      defaultValue={defaults.description}
                      className="field"
                      placeholder="What this agent does"
                    />
                  </Field>
                  <Field label="Instructions · system prompt">
                    <textarea
                      name="instructions"
                      defaultValue={defaults.instructions}
                      rows={6}
                      className="field"
                      required
                    />
                  </Field>
                  <Row>
                    <Field label="Provider">
                      <select
                        name="providerId"
                        defaultValue={defaults.providerId}
                        className="field"
                      >
                        <option value="">— no provider yet —</option>
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Model">
                      <input
                        name="model"
                        defaultValue={defaults.model}
                        className="field"
                        placeholder="gpt-4.1-mini"
                      />
                    </Field>
                  </Row>
                  <Field label="Tools / integrations · comma-separated tags">
                    <input
                      name="tools"
                      defaultValue={defaults.tools?.join(", ")}
                      className="field"
                      placeholder="gmail, slack, github"
                    />
                  </Field>
                </Section>

                <Section
                  number="02 / 05"
                  kicker="TRIGGER"
                  title="Invocation rules"
                  sub="How this agent gets invoked. Manual always works; schedules drive the next-run estimate."
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                    {TRIGGER_KINDS.map((kind) => {
                      const active = triggerKind === kind;
                      return (
                        <button
                          type="button"
                          key={kind}
                          onClick={() => updateTriggerKind(kind)}
                          className={active ? "btn-primary btn btn-sm" : "btn btn-sm"}
                        >
                          {triggerLabel(kind)}
                        </button>
                      );
                    })}
                  </div>
                  <Row>
                    <Field
                      label={
                        triggerKind === "schedule" ? "Cron schedule *" : "Cron schedule · optional"
                      }
                    >
                      <input
                        name="schedule"
                        className="field mono"
                        value={schedule}
                        onBlur={() => setScheduleTouched(true)}
                        onChange={(e) => {
                          setSchedule(e.target.value);
                          setScheduleTouched(true);
                        }}
                        placeholder="0 8 * * 1-5"
                        required={triggerKind === "schedule"}
                      />
                      <p className="mono muted" style={{ fontSize: 10, marginTop: 6 }}>
                        Five-field cron in workspace time. Examples:{" "}
                        <span style={{ color: "var(--silver-200)" }}>0 8 * * 1-5</span> weekdays at
                        08:00, <span style={{ color: "var(--silver-200)" }}>*/30 * * * *</span>{" "}
                        every 30m.
                      </p>
                      {showScheduleValidation && (
                        <p
                          className="mono"
                          style={{ fontSize: 10.5, marginTop: 4, color: "var(--danger)" }}
                        >
                          ERR · {scheduleValidation}
                        </p>
                      )}
                    </Field>
                    <Field label={triggerKind === "schedule" ? "Next run" : "Trigger mode"}>
                      <div className="field mono" style={{ background: "var(--bg-elev)" }}>
                        {nextRunLabel}
                      </div>
                    </Field>
                  </Row>
                  {!isNew && agent && (
                    <div
                      style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}
                    >
                      <div className="kicker" style={{ marginBottom: 6 }}>
                        WEBHOOK TRIGGER
                      </div>
                      {hasWebhook ? (
                        <div style={{ display: "grid", gap: 8 }}>
                          <div
                            className="mono"
                            style={{
                              fontSize: 11,
                              padding: "8px 10px",
                              background: "var(--ink)",
                              border: "1px solid var(--line)",
                              borderRadius: 6,
                              color: "var(--silver-200)",
                              wordBreak: "break-all",
                            }}
                          >
                            POST {webhookOrigin()}/api/public/webhooks/agents/
                            {webhookPathToken ?? "[redacted]"}
                          </div>
                          <p className="mono muted" style={{ fontSize: 10 }}>
                            Body is forwarded as the run's `inputs`. Trigger kind = webhook. Full
                            token is only shown immediately after rotation.
                          </p>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                void rotateWebhook();
                              }}
                              disabled={webhookBusy}
                            >
                              <I.refresh size={11} /> Rotate token
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                void removeWebhook();
                              }}
                              disabled={webhookBusy}
                              style={{ color: "var(--danger)" }}
                            >
                              <I.trash size={11} /> Remove
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            void rotateWebhook();
                          }}
                          disabled={webhookBusy}
                        >
                          <I.plus size={11} /> Generate webhook URL
                        </button>
                      )}
                    </div>
                  )}
                </Section>

                <Section
                  number="03 / 05"
                  kicker={`PLAYBOOK · ${playbook.length} STEP${playbook.length === 1 ? "" : "S"}`}
                  title="Ordered steps"
                >
                  <PlaybookEditor
                    steps={playbook}
                    showValidation={playbookValidationVisible}
                    onChange={updatePlaybook}
                  />
                </Section>

                <div ref={toolSectionRef}>
                  <Section
                    number="04 / 05"
                    kicker={`TOOLS · ${enabledTools.length} ENABLED`}
                    title="Available tool registry"
                    sub="Enabling any tool runs the agent through the tool-use loop on save."
                  >
                    <ToolPicker
                      tools={availableTools}
                      enabled={enabledTools}
                      onChange={updateEnabledTools}
                    />
                  </Section>
                </div>

                <Section
                  number="05 / 05"
                  kicker="MEMORY · INPUTS · EVALUATION"
                  title="First-run contract"
                  sub="Bounded non-secret context, saved input examples, and deterministic evaluation expectations."
                >
                  <div className="kicker" style={{ marginBottom: 8 }}>
                    MEMORY
                  </div>
                  <MemoryEditor memory={memory} onChange={setMemory} />
                  <div
                    className="kicker"
                    style={{
                      marginTop: 16,
                      paddingTop: 16,
                      borderTop: "1px solid var(--line)",
                      marginBottom: 8,
                    }}
                  >
                    INPUT SCHEMA & EXAMPLES
                  </div>
                  <InputSchemaEditor schema={inputSchema} onChange={updateInputSchema} />
                  <div
                    style={{
                      marginTop: 16,
                      paddingTop: 16,
                      borderTop: "1px solid var(--line)",
                    }}
                  >
                    <Field label="Expected output · operator review context">
                      <textarea
                        className="field"
                        rows={3}
                        maxLength={1_200}
                        value={evaluationExpectedOutput}
                        onChange={(event) => setEvaluationExpectedOutput(event.target.value)}
                      />
                    </Field>
                    <div className="label" style={{ marginTop: 10 }}>
                      Required successful tool calls
                    </div>
                    {enabledTools.length === 0 ? (
                      <div className="mono muted" style={{ fontSize: 11 }}>
                        No enabled tool is required.
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {enabledTools.map((tool) => (
                          <label
                            key={tool}
                            className="mono"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              fontSize: 11,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={evaluationTools.includes(tool)}
                              onChange={(event) =>
                                setEvaluationTools((current) =>
                                  event.target.checked
                                    ? Array.from(new Set([...current, tool]))
                                    : current.filter((candidate) => candidate !== tool),
                                )
                              }
                            />
                            {tool}
                          </label>
                        ))}
                      </div>
                    )}
                    <p className="mono muted" style={{ fontSize: 10.5, marginTop: 8 }}>
                      Pass/fail is structural: saved input example, successful bounded run,
                      non-empty output, and these tool calls. Expected-output text is shown for
                      review, not graded by a second model.
                    </p>
                  </div>
                </Section>

                <div
                  style={{
                    marginTop: 18,
                    paddingTop: 16,
                    borderTop: "1px solid var(--line)",
                    display: "flex",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={!canManageAgent || saving}
                  >
                    {saving ? (
                      <span className="spin">
                        <I.refresh size={13} />
                      </span>
                    ) : (
                      <I.check size={13} />
                    )}
                    {isNew ? " Create agent" : " Save agent"}
                  </button>
                </div>
              </fieldset>
            </form>

            <aside style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {!isNew && agent && (
                <div>
                  <div className="kicker" style={{ marginBottom: 8 }}>
                    RUN WITH INPUTS
                  </div>
                  {inputSchema.length === 0 ? (
                    <div
                      className="card muted"
                      style={{ padding: "12px 14px", fontSize: 12, textAlign: "center" }}
                    >
                      — no inputs defined —
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {inputSchema.map((f) => (
                        <RunInputControl
                          key={f.key}
                          field={f}
                          value={runInputs[f.key] ?? ""}
                          onChange={(next) => updateRunInputValue(f.key, next)}
                        />
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ width: "100%", marginTop: 10, justifyContent: "center" }}
                    onClick={() => {
                      void runNow();
                    }}
                    disabled={!canRunAgent || running || saving}
                  >
                    {running ? (
                      <span className="spin">
                        <I.refresh size={13} />
                      </span>
                    ) : (
                      <I.play size={13} />
                    )}
                    {canRunAgent
                      ? firstRunEvaluationPending
                        ? " Evaluate first run"
                        : " Execute"
                      : " Member role required"}
                  </button>
                  {pendingApproval && (
                    <ApprovalPanel
                      pending={pendingApproval}
                      running={running}
                      saving={saving}
                      canRunAgent={canRunAgent}
                      onLaunch={() => {
                        void launchPendingApproval();
                      }}
                      onEditTools={editPendingTools}
                      onCancel={cancelPendingApproval}
                    />
                  )}
                </div>
              )}

              <div>
                <div className="kicker" style={{ marginBottom: 8 }}>
                  RECENT RUNS
                </div>
                {runs.length === 0 ? (
                  <div
                    className="card muted"
                    style={{ padding: "12px 14px", fontSize: 12, textAlign: "center" }}
                  >
                    — no runs recorded —
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {runs.map((r) => {
                      const expanded = expandedRun === r.id;
                      return (
                        <div key={r.id} className="card" style={{ padding: 12 }}>
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedRun(expanded ? null : r.id);
                              if (expanded && playbookReviewRunId === r.id)
                                setPlaybookReviewRunId(null);
                            }}
                            style={{
                              background: "transparent",
                              border: "none",
                              padding: 0,
                              color: "var(--silver-100)",
                              cursor: "pointer",
                              textAlign: "left",
                              width: "100%",
                              display: "flex",
                              gap: 8,
                              alignItems: "flex-start",
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  marginBottom: 4,
                                }}
                              >
                                <span
                                  className={`pill ${r.status === "success" ? "good" : r.status === "failed" ? "danger" : r.status === "running" ? "warn" : "muted"}`}
                                >
                                  <span className="dot"></span>
                                  {r.status}
                                </span>
                                <span
                                  style={{
                                    fontSize: 12,
                                    color: "var(--silver-100)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {r.title}
                                </span>
                              </div>
                              <div className="mono muted" style={{ fontSize: 10.5 }}>
                                {new Date(r.createdAt).toLocaleString()} ·{" "}
                                {triggerLabel(r.triggerKind)}
                              </div>
                            </div>
                            <span className="mono muted" style={{ fontSize: 11 }}>
                              {expanded ? "[ − ]" : "[ + ]"}
                            </span>
                          </button>
                          {r.error && (
                            <div
                              className="mono"
                              style={{ fontSize: 11, color: "var(--danger)", marginTop: 6 }}
                            >
                              ERR · {r.error}
                            </div>
                          )}
                          {expanded && (
                            <div
                              style={{
                                marginTop: 10,
                                paddingTop: 10,
                                borderTop: "1px solid var(--line)",
                                display: "flex",
                                flexDirection: "column",
                                gap: 10,
                              }}
                            >
                              <RunTranscript steps={r.transcript} />
                              {r.evaluation && <FirstRunEvaluationPanel run={r} />}
                              {r.toolCalls && r.toolCalls.length > 0 && (
                                <div>
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      alignItems: "center",
                                      marginBottom: 6,
                                    }}
                                  >
                                    <div className="kicker">TOOL CALLS · {r.toolCalls.length}</div>
                                    <button
                                      type="button"
                                      className="btn btn-sm"
                                      onClick={() => setPlaybookReviewRunId(r.id)}
                                      disabled={!canManageAgent || recordingRunId === r.id}
                                      title="Review the replacement playbook before updating this agent"
                                    >
                                      {recordingRunId === r.id ? (
                                        <span className="spin">
                                          <I.refresh size={11} />
                                        </span>
                                      ) : (
                                        <I.eye size={11} />
                                      )}
                                      {recordingRunId === r.id
                                        ? " Replacing..."
                                        : " Review replacement"}
                                    </button>
                                  </div>
                                  {playbookReviewRunId === r.id && (
                                    <PlaybookReplacementReview
                                      run={r}
                                      currentStepCount={playbook.length}
                                      recording={recordingRunId === r.id}
                                      canRunAgent={canManageAgent}
                                      onConfirm={() => {
                                        void recordAsPlaybook(r.id);
                                      }}
                                      onCancel={() => setPlaybookReviewRunId(null)}
                                    />
                                  )}
                                  <ToolCallTimeline calls={r.toolCalls} />
                                </div>
                              )}
                              {r.output && (
                                <pre
                                  className="mono"
                                  style={{
                                    margin: 0,
                                    padding: 10,
                                    fontSize: 11,
                                    lineHeight: 1.5,
                                    background: "var(--ink)",
                                    border: "1px solid var(--line)",
                                    borderRadius: 6,
                                    color: "var(--silver-200)",
                                    whiteSpace: "pre-wrap",
                                  }}
                                >
                                  {r.output}
                                </pre>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </>
  );
}

function Section({
  number,
  kicker,
  title,
  sub,
  children,
}: {
  number: string;
  kicker: string;
  title: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <div className="card" style={{ padding: 22, marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <div className="kicker" style={{ marginBottom: 4 }}>
            {kicker}
          </div>
          <h2 className="h2" style={{ fontSize: 18 }}>
            {title}
          </h2>
          {sub && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 480 }}>
              {sub}
            </p>
          )}
        </div>
        <span className="mono muted" style={{ fontSize: 10.5, letterSpacing: "0.12em" }}>
          § {number}
        </span>
      </div>
      {children}
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function fieldValue(form: FormData, key: string) {
  return String(form.get(key) || "").trim();
}

function lines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function seedRunInputs(schema: AgentInputField[]): Record<string, string> {
  const next: Record<string, string> = {};
  for (const f of schema) {
    if (f.exampleValue !== undefined) next[f.key] = f.exampleValue;
    else if (f.defaultValue !== undefined) next[f.key] = f.defaultValue;
    else if (f.type === "boolean") next[f.key] = "false";
    else next[f.key] = "";
  }
  return next;
}

function buildRunInputPayload(
  schema: AgentInputField[],
  values: Record<string, string>,
): Record<string, string | number | boolean> {
  const payload: Record<string, string | number | boolean> = {};
  for (const f of schema) {
    const raw = values[f.key];
    if (raw === undefined || raw === "") continue;
    if (f.type === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) payload[f.key] = n;
    } else if (f.type === "boolean") {
      payload[f.key] = raw === "true";
    } else {
      payload[f.key] = raw;
    }
  }
  return payload;
}

function missingPlaybookTitleIndexes(steps: AgentPlaybookStep[]) {
  return steps.flatMap((step, index) => (step.title.trim().length > 0 ? [] : [index]));
}

function formatStepNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

function formatStepList(indexes: number[]) {
  const labels = indexes.slice(0, 4).map(formatStepNumber);
  if (indexes.length <= labels.length) return labels.join(", ");
  return `${labels.join(", ")} +${indexes.length - labels.length} more`;
}

function isApprovalResult(
  result: RunAgentResult | null | undefined,
): result is Extract<RunAgentResult, { approval: ToolCapabilityApprovalRequest }> {
  return Boolean(result && typeof result === "object" && "approval" in result && result.approval);
}

function runFromAgentResult(result: RunAgentResult | null | undefined): AgentRunRecord | null {
  if (!result || typeof result !== "object") return null;
  if ("approval" in result) return null;
  return result.run;
}

function riskForApprovalTool(tool: ToolCapabilityApprovalTool): ToolRisk {
  if (tool.risk === "low" || tool.risk === "medium" || tool.risk === "high") return tool.risk;
  if (tool.side === "exec") return "high";
  if (tool.side === "write") return "medium";
  return "low";
}

function riskPillClass(risk: ToolRisk) {
  if (risk === "high") return "danger";
  if (risk === "medium") return "warn";
  return "good";
}

function formatApprovalExpiry(expiresAt: string) {
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time)) return expiresAt;
  return new Date(time).toLocaleString();
}

function ApprovalPanel({
  pending,
  running,
  saving,
  canRunAgent,
  onLaunch,
  onEditTools,
  onCancel,
}: {
  pending: PendingRunApproval;
  running: boolean;
  saving: boolean;
  canRunAgent: boolean;
  onLaunch: () => void;
  onEditTools: () => void;
  onCancel: () => void;
}) {
  const { approval } = pending;
  return (
    <div
      className="card"
      style={{
        marginTop: 10,
        padding: 12,
        borderColor: "rgba(242,196,92,0.32)",
        background: "rgba(242,196,92,0.045)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <I.shield size={14} style={{ color: "var(--warn)", marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="kicker" style={{ color: "var(--warn)", marginBottom: 4 }}>
            TOOL APPROVAL
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--silver-200)" }}>
            {triggerLabel(approval.triggerKind)} run · {approval.tools.length} tool
            {approval.tools.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      {approval.summary && (
        <p
          style={{ margin: "9px 0 0", fontSize: 12, lineHeight: 1.45, color: "var(--silver-300)" }}
        >
          {approval.summary}
        </p>
      )}

      <div
        style={{
          marginTop: 10,
          borderTop: "1px solid var(--line)",
          paddingTop: 8,
          display: "grid",
          gap: 6,
        }}
      >
        {approval.tools.map((tool) => {
          const risk = riskForApprovalTool(tool);
          return (
            <div key={tool.name} style={{ display: "grid", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: "var(--silver-100)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tool.name}
                </span>
                <span
                  className={`pill ${riskPillClass(risk)}`}
                  style={{ fontSize: 9, padding: "1px 5px", flexShrink: 0 }}
                >
                  {risk}/{tool.side}
                </span>
              </div>
              <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.35 }}>
                {tool.riskSummary || tool.description}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mono muted" style={{ marginTop: 9, fontSize: 10 }}>
        expires {formatApprovalExpiry(approval.expiresAt)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onLaunch}
          disabled={!canRunAgent || running || saving}
        >
          {running ? (
            <span className="spin">
              <I.refresh size={11} />
            </span>
          ) : (
            <I.rocket size={11} />
          )}{" "}
          Launch
        </button>
        <button type="button" className="btn btn-sm" onClick={onEditTools} disabled={running}>
          <I.edit size={11} /> Edit tools
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onCancel}
          disabled={running}
          style={{ color: "var(--danger)" }}
        >
          <I.close size={11} /> Cancel
        </button>
      </div>
    </div>
  );
}

function PlaybookReplacementReview({
  run,
  currentStepCount,
  recording,
  canRunAgent,
  onConfirm,
  onCancel,
}: {
  run: AgentRunRecord;
  currentStepCount: number;
  recording: boolean;
  canRunAgent: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const preview = playbookPreviewFromToolCalls(run.toolCalls ?? []);
  if (preview.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Review playbook replacement"
      style={{
        border: "1px solid rgba(242,196,92,0.32)",
        background: "rgba(242,196,92,0.045)",
        borderRadius: 6,
        padding: 10,
        display: "grid",
        gap: 9,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <I.alert size={13} style={{ color: "var(--warn)", marginTop: 1, flexShrink: 0 }} />
        <div>
          <div className="kicker" style={{ color: "var(--warn)", marginBottom: 4 }}>
            REVIEW REPLACEMENT
          </div>
          <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: "var(--silver-300)" }}>
            This will replace the current {formatStepCount(currentStepCount)} with{" "}
            {formatStepCount(preview.length)} captured from this run.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        {preview.slice(0, 5).map((step, index) => (
          <div
            key={`${step.title}-${index}`}
            style={{
              display: "grid",
              gridTemplateColumns: "26px 1fr",
              gap: 8,
              alignItems: "start",
            }}
          >
            <span className="mono muted" style={{ fontSize: 10.5 }}>
              {formatStepNumber(index)}
            </span>
            <span style={{ minWidth: 0 }}>
              <span
                className="mono"
                style={{
                  display: "block",
                  fontSize: 11.5,
                  color: "var(--silver-100)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {step.title}
              </span>
              <span
                className="muted"
                style={{
                  display: "block",
                  fontSize: 10.5,
                  lineHeight: 1.35,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {step.instruction}
              </span>
            </span>
          </div>
        ))}
        {preview.length > 5 && (
          <div className="mono muted" style={{ fontSize: 10.5 }}>
            +{preview.length - 5} more steps
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onConfirm}
          disabled={!canRunAgent || recording}
        >
          {recording ? (
            <span className="spin">
              <I.refresh size={11} />
            </span>
          ) : (
            <I.check size={11} />
          )}
          {recording ? " Replacing..." : " Confirm replace"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={recording}>
          <I.close size={11} /> Cancel
        </button>
      </div>
    </div>
  );
}

function playbookPreviewFromToolCalls(calls: AgentRunToolCall[]) {
  return calls.slice(0, 20).map((call, index) => ({
    title: `${index + 1}. ${call.toolName}`,
    instruction: `Call ${call.toolName} with: ${stringifyToolCallInput(call.input).slice(0, 380)}`,
  }));
}

function stringifyToolCallInput(input: unknown) {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function formatStepCount(count: number) {
  return `${count} step${count === 1 ? "" : "s"}`;
}

// ─── PlaybookEditor ─────────────────────────────────────────────────────────
function PlaybookEditor({
  steps,
  showValidation,
  onChange,
}: {
  steps: AgentPlaybookStep[];
  showValidation: boolean;
  onChange: (next: AgentPlaybookStep[]) => void;
}) {
  const [touchedTitleIds, setTouchedTitleIds] = useState<Set<string>>(() => new Set());
  const update = (index: number, patch: Partial<AgentPlaybookStep>) => {
    const next = steps.slice();
    next[index] = { ...next[index]!, ...patch };
    onChange(next);
  };
  const addStep = () =>
    onChange([
      ...steps,
      {
        id: `step_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        title: "",
        instruction: "",
      },
    ]);
  const removeStep = (index: number) => {
    const next = steps.slice();
    next.splice(index, 1);
    onChange(next);
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = steps.slice();
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const missingTitles = missingPlaybookTitleIndexes(steps);
  const touchTitle = (stepId: string) => {
    setTouchedTitleIds((previous) => {
      const next = new Set(previous);
      next.add(stepId);
      return next;
    });
  };
  return (
    <div>
      {showValidation && missingTitles.length > 0 && (
        <div
          role="alert"
          style={{
            border: "1px solid rgba(242,107,92,0.34)",
            background: "rgba(242,107,92,0.06)",
            borderRadius: 6,
            padding: "9px 10px",
            marginBottom: 10,
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            color: "var(--danger)",
          }}
        >
          <I.alert size={13} style={{ marginTop: 1, flexShrink: 0 }} />
          <span className="mono" style={{ fontSize: 11, lineHeight: 1.4 }}>
            {missingTitles.length === 1
              ? `Step ${formatStepList(missingTitles)} needs a title before this playbook can be saved.`
              : `Steps ${formatStepList(missingTitles)} need titles before this playbook can be saved.`}
          </span>
        </div>
      )}
      {steps.length === 0 ? (
        <div
          className="card muted"
          style={{ padding: "12px 14px", textAlign: "center", fontSize: 12 }}
        >
          — empty playbook · add a step so each run produces a transcript —
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {steps.map((step, index) => {
            const stepNumber = formatStepNumber(index);
            const missingTitle = step.title.trim().length === 0;
            const showTitleError =
              missingTitle &&
              (showValidation ||
                touchedTitleIds.has(step.id) ||
                step.instruction.trim().length > 0);
            const titleErrorId = `playbook_${step.id}_title_error`;
            return (
              <div
                key={step.id}
                className="card"
                style={{
                  padding: 12,
                  display: "grid",
                  gridTemplateColumns: "32px 1fr 36px",
                  gap: 10,
                  borderColor: showTitleError ? "rgba(242,107,92,0.38)" : undefined,
                }}
              >
                <div className="mono muted" style={{ fontSize: 11, paddingTop: 21 }}>
                  {stepNumber}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span className="label">Title</span>
                    <input
                      className="field"
                      placeholder="Step title"
                      value={step.title}
                      aria-invalid={showTitleError}
                      aria-describedby={showTitleError ? titleErrorId : undefined}
                      onBlur={() => touchTitle(step.id)}
                      onChange={(e) => update(index, { title: e.target.value })}
                    />
                    {showTitleError && (
                      <span
                        id={titleErrorId}
                        role="alert"
                        className="mono"
                        style={{ fontSize: 10.5, color: "var(--danger)" }}
                      >
                        ERR · Step {stepNumber} needs a title or should be removed.
                      </span>
                    )}
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span className="label">Instruction</span>
                    <textarea
                      className="field"
                      rows={2}
                      placeholder="What the agent should do"
                      value={step.instruction}
                      onChange={(e) => update(index, { instruction: e.target.value })}
                    />
                  </label>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 4,
                    fontSize: 11,
                    paddingTop: 18,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move step ${stepNumber} up`}
                    title={`Move step ${stepNumber} up`}
                    className="btn btn-sm"
                    style={{
                      width: 30,
                      height: 26,
                      padding: 0,
                      justifyContent: "center",
                      opacity: index === 0 ? 0.3 : 1,
                    }}
                  >
                    <I.arrowUp size={11} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === steps.length - 1}
                    aria-label={`Move step ${stepNumber} down`}
                    title={`Move step ${stepNumber} down`}
                    className="btn btn-sm"
                    style={{
                      width: 30,
                      height: 26,
                      padding: 0,
                      justifyContent: "center",
                      opacity: index === steps.length - 1 ? 0.3 : 1,
                    }}
                  >
                    <I.chevDown size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStep(index)}
                    aria-label={`Remove step ${stepNumber}`}
                    title={`Remove step ${stepNumber}`}
                    className="btn btn-sm"
                    style={{
                      width: 30,
                      height: 26,
                      padding: 0,
                      justifyContent: "center",
                      color: "var(--danger)",
                    }}
                  >
                    <I.trash size={11} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button type="button" onClick={addStep} className="btn btn-sm">
          <I.plus size={11} /> Add step
        </button>
      </div>
    </div>
  );
}

// ─── ToolPicker ─────────────────────────────────────────────────────────────
function ToolPicker({
  tools,
  enabled,
  onChange,
}: {
  tools: AvailableTool[];
  enabled: string[];
  onChange: (next: string[]) => void;
}) {
  const enabledSet = new Set(enabled);
  if (tools.length === 0) {
    return (
      <div
        className="card muted"
        style={{ padding: "12px 14px", textAlign: "center", fontSize: 12 }}
      >
        — tool registry empty —
      </div>
    );
  }
  const groups: Record<"read" | "write" | "exec", AvailableTool[]> = {
    read: [],
    write: [],
    exec: [],
  };
  for (const t of tools) groups[t.side].push(t);
  const toggle = (name: string) => {
    if (enabledSet.has(name)) onChange(enabled.filter((n) => n !== name));
    else onChange([...enabled, name]);
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
        gap: 10,
      }}
    >
      {(["read", "write", "exec"] as const).map((side) => (
        <div key={side} className="card" style={{ padding: 12 }}>
          <div className="kicker" style={{ marginBottom: 8, color: "var(--green)" }}>
            {side.toUpperCase()} · {groups[side].length}
          </div>
          {groups[side].length === 0 ? (
            <p className="mono muted" style={{ fontSize: 11 }}>
              — none —
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {groups[side].map((t) => (
                <label
                  key={t.name}
                  style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={enabledSet.has(t.name)}
                    onChange={() => toggle(t.name)}
                    style={{ marginTop: 2, accentColor: "var(--green)" }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      className="mono"
                      style={{ fontSize: 11.5, color: "var(--silver-100)", display: "block" }}
                    >
                      {t.name}
                    </span>
                    <span className="muted" style={{ fontSize: 10.5, lineHeight: 1.4 }}>
                      {t.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MemoryEditor({
  memory,
  onChange,
}: {
  memory: AgentMemoryEntry[];
  onChange: (next: AgentMemoryEntry[]) => void;
}) {
  const update = (index: number, patch: Partial<AgentMemoryEntry>) =>
    onChange(
      memory.map((entry, candidate) => (candidate === index ? { ...entry, ...patch } : entry)),
    );
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {memory.length === 0 && (
        <div className="card muted" style={{ padding: "12px 14px", fontSize: 12 }}>
          — no saved context · secrets belong in credential references —
        </div>
      )}
      {memory.map((entry, index) => (
        <div
          key={entry.id}
          className="card"
          style={{
            padding: 10,
            display: "grid",
            gridTemplateColumns: "minmax(120px, 0.35fr) minmax(0, 1fr) auto",
            gap: 8,
            alignItems: "start",
          }}
        >
          <input
            className="field"
            value={entry.label}
            maxLength={80}
            aria-label={`Memory ${index + 1} label`}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <textarea
            className="field"
            value={entry.content}
            maxLength={1_000}
            rows={2}
            aria-label={`Memory ${index + 1} content`}
            onChange={(event) => update(index, { content: event.target.value })}
          />
          <button
            type="button"
            className="btn btn-sm"
            style={{ color: "var(--danger)" }}
            aria-label={`Remove memory ${index + 1}`}
            onClick={() => onChange(memory.filter((_, candidate) => candidate !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={memory.length >= 12}
          onClick={() =>
            onChange([...memory, { id: `memory_${Date.now()}`, label: "Context", content: "" }])
          }
        >
          <I.plus size={11} /> Add memory
        </button>
      </div>
    </div>
  );
}

// ─── InputSchemaEditor ──────────────────────────────────────────────────────
function InputSchemaEditor({
  schema,
  onChange,
}: {
  schema: AgentInputField[];
  onChange: (next: AgentInputField[]) => void;
}) {
  const update = (index: number, patch: Partial<AgentInputField>) =>
    onChange(schema.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  const remove = (index: number) => onChange(schema.filter((_, i) => i !== index));
  const add = () =>
    onChange([
      ...schema,
      {
        key: `field_${schema.length + 1}`,
        label: `Field ${schema.length + 1}`,
        type: "string",
        required: false,
      },
    ]);

  return (
    <div>
      {schema.length === 0 ? (
        <div
          className="card muted"
          style={{ padding: "12px 14px", textAlign: "center", fontSize: 12 }}
        >
          — empty schema · add a field to capture per-run parameters —
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Type</th>
                <th>Req</th>
                <th>Options</th>
                <th>Default</th>
                <th>Example</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {schema.map((f, index) => (
                <tr key={index}>
                  <td>
                    <input
                      className="field mono"
                      style={{ fontSize: 11, padding: "5px 8px" }}
                      placeholder="key"
                      value={f.key}
                      onChange={(e) =>
                        update(index, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      style={{ fontSize: 12, padding: "5px 8px" }}
                      placeholder="Label"
                      value={f.label}
                      onChange={(e) => update(index, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="field mono"
                      style={{ fontSize: 11, padding: "5px 8px" }}
                      value={f.type}
                      onChange={(e) => {
                        const type = e.target.value as AgentInputFieldType;
                        update(index, {
                          type,
                          options:
                            type === "enum"
                              ? f.options && f.options.length > 0
                                ? f.options
                                : ["option_a"]
                              : undefined,
                        });
                      }}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => update(index, { required: e.target.checked })}
                      style={{ accentColor: "var(--green)" }}
                    />
                  </td>
                  <td>
                    {f.type === "enum" ? (
                      <textarea
                        className="field mono"
                        style={{
                          fontSize: 11,
                          padding: "5px 8px",
                          minHeight: 50,
                          minWidth: 140,
                          resize: "none",
                        }}
                        placeholder="one per line"
                        rows={2}
                        value={(f.options ?? []).join("\n")}
                        onChange={(e) => update(index, { options: lines(e.target.value) })}
                      />
                    ) : (
                      <span className="mono muted" style={{ fontSize: 11 }}>
                        —
                      </span>
                    )}
                  </td>
                  <td>
                    <input
                      className="field"
                      style={{ fontSize: 12, padding: "5px 8px" }}
                      placeholder="—"
                      value={f.defaultValue ?? ""}
                      onChange={(e) => update(index, { defaultValue: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      style={{ fontSize: 12, padding: "5px 8px" }}
                      placeholder="first run"
                      value={f.exampleValue ?? ""}
                      onChange={(e) => update(index, { exampleValue: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      className="btn btn-sm"
                      style={{ padding: "3px 6px", color: "var(--danger)" }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button type="button" onClick={add} className="btn btn-sm">
          <I.plus size={11} /> Add field
        </button>
      </div>
    </div>
  );
}

function RunInputControl({
  field: f,
  value,
  onChange,
}: {
  field: AgentInputField;
  value: string;
  onChange: (next: string) => void;
}) {
  if (f.type === "enum") {
    return (
      <Field label={`${f.label}${f.required ? " *" : ""}`}>
        <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— select —</option>
          {(f.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (f.type === "boolean") {
    return (
      <label
        className="mono"
        style={{
          fontSize: 12,
          color: "var(--silver-200)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          style={{ accentColor: "var(--green)" }}
        />
        {f.label}
      </label>
    );
  }
  return (
    <Field label={`${f.label}${f.required ? " *" : ""}`}>
      <input
        className="field"
        type={f.type === "number" ? "number" : f.type === "url" ? "url" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={f.description}
      />
    </Field>
  );
}

// ─── RunTranscript / ToolCallTimeline (workbench-styled) ────────────────────
export function RunTranscript({ steps }: { steps: AgentRunStep[] | undefined }) {
  if (!steps || steps.length === 0) {
    return (
      <div
        className="mono muted"
        style={{
          fontSize: 11,
          padding: "8px 10px",
          border: "1px dashed var(--line-2)",
          borderRadius: 6,
        }}
      >
        — no transcript captured for this run —
      </div>
    );
  }
  const statusPill = (s: AgentRunStepStatus) =>
    s === "success" ? "good" : s === "failed" ? "danger" : "muted";
  const statusLabel = (s: AgentRunStepStatus) =>
    s === "success" ? "OK" : s === "failed" ? "FAIL" : "SKIP";
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {steps.map((step, index) => (
        <div
          key={step.id}
          style={{
            display: "grid",
            gridTemplateColumns: "32px 1fr auto",
            alignItems: "baseline",
            gap: 10,
            padding: "10px 0",
            borderTop: index === 0 ? "none" : "1px solid var(--line)",
          }}
        >
          <div className="mono muted" style={{ fontSize: 11 }}>
            {String(index + 1).padStart(2, "0")}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={`pill ${statusPill(step.status)}`}>{statusLabel(step.status)}</span>
              <span style={{ fontSize: 12.5, color: "var(--silver-100)" }}>{step.title}</span>
            </div>
            {step.output && (
              <p style={{ marginTop: 4, fontSize: 11.5, color: "var(--silver-400)" }}>
                {step.output}
              </p>
            )}
          </div>
          <div className="mono muted" style={{ fontSize: 11 }}>
            {formatDuration(step.durationMs)}
          </div>
        </div>
      ))}
    </div>
  );
}

function FirstRunEvaluationPanel({ run }: { run: AgentRunRecord }) {
  const evaluation = run.evaluation;
  if (!evaluation) return null;

  return (
    <div
      role="group"
      aria-label="First-run evaluation evidence"
      style={{
        border: `1px solid ${
          evaluation.status === "passed" ? "rgba(74,222,128,0.28)" : "rgba(248,113,113,0.34)"
        }`,
        background:
          evaluation.status === "passed" ? "rgba(74,222,128,0.035)" : "rgba(248,113,113,0.045)",
        borderRadius: 6,
        padding: 10,
        display: "grid",
        gap: 9,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <div className="kicker">FIRST-RUN EVALUATION</div>
        <span className={`pill ${evaluation.status === "passed" ? "good" : "danger"}`}>
          {evaluation.status}
        </span>
      </div>
      <div style={{ display: "grid", gap: 5 }}>
        {evaluation.checks.map((check) => (
          <div
            key={check.id}
            style={{
              display: "grid",
              gridTemplateColumns: "52px minmax(0, 1fr)",
              gap: 8,
              alignItems: "start",
            }}
          >
            <span className={`pill ${check.status === "passed" ? "good" : "danger"}`}>
              {check.status === "passed" ? "PASS" : "FAIL"}
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="mono" style={{ display: "block", fontSize: 11 }}>
                {check.label}
              </span>
              <span className="muted" style={{ display: "block", fontSize: 10.5 }}>
                {check.note}
              </span>
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 8,
        }}
      >
        <div>
          <div className="kicker" style={{ marginBottom: 4 }}>
            EXPECTED OUTPUT
          </div>
          <div className="mono muted" style={{ fontSize: 10.5, whiteSpace: "pre-wrap" }}>
            {evaluation.expected.output || "Non-empty output."}
          </div>
        </div>
        <div>
          <div className="kicker" style={{ marginBottom: 4 }}>
            ACTUAL OUTPUT
          </div>
          <div className="mono muted" style={{ fontSize: 10.5, whiteSpace: "pre-wrap" }}>
            {evaluation.actual.output || "No output captured."}
          </div>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
        {evaluation.notes.join(" ")}
      </div>
    </div>
  );
}

export function ToolCallTimeline({ calls }: { calls: AgentRunToolCall[] | undefined }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!calls || calls.length === 0) return null;
  const statusPill = (s: AgentRunToolCall["status"]) =>
    s === "ok" ? "good" : s === "timeout" ? "warn" : "danger";
  const statusLabel = (s: AgentRunToolCall["status"]) =>
    s === "ok" ? "OK" : s === "timeout" ? "T/O" : "ERR";
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {calls.map((call, index) => {
        const open = expanded === call.id;
        return (
          <div
            key={call.id}
            style={{ padding: "8px 0", borderTop: index === 0 ? "none" : "1px solid var(--line)" }}
          >
            <button
              type="button"
              onClick={() => setExpanded(open ? null : call.id)}
              style={{
                display: "grid",
                gridTemplateColumns: "32px 1fr 60px 30px",
                gap: 8,
                alignItems: "baseline",
                textAlign: "left",
                width: "100%",
                border: "none",
                background: "transparent",
                color: "inherit",
                padding: 0,
                cursor: "pointer",
              }}
            >
              <span className="mono muted" style={{ fontSize: 11 }}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--silver-200)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <span className={`pill ${statusPill(call.status)}`}>
                  {statusLabel(call.status)}
                </span>
                <span style={{ marginLeft: 8, color: "var(--green)" }}>{call.toolName}</span>
                {call.error && (
                  <span style={{ marginLeft: 8, color: "var(--danger)" }}>{call.error}</span>
                )}
              </span>
              <span className="mono muted" style={{ fontSize: 10, textAlign: "right" }}>
                {call.durationMs}ms
              </span>
              <span className="mono muted" style={{ fontSize: 10, textAlign: "right" }}>
                {open ? "[ − ]" : "[ + ]"}
              </span>
            </button>
            {open && (
              <div style={{ marginTop: 8, paddingLeft: 40, display: "grid", gap: 8 }}>
                <div>
                  <div className="kicker" style={{ marginBottom: 4 }}>
                    INPUT
                  </div>
                  <pre
                    className="mono"
                    style={{
                      margin: 0,
                      padding: 8,
                      fontSize: 10.5,
                      lineHeight: 1.5,
                      background: "var(--ink)",
                      border: "1px solid var(--line)",
                      borderRadius: 6,
                      color: "var(--silver-200)",
                      overflow: "auto",
                    }}
                  >
                    {safeStringify(call.input)}
                  </pre>
                </div>
                {call.output !== undefined && (
                  <div>
                    <div className="kicker" style={{ marginBottom: 4 }}>
                      OUTPUT
                    </div>
                    <pre
                      className="mono"
                      style={{
                        margin: 0,
                        padding: 8,
                        fontSize: 10.5,
                        lineHeight: 1.5,
                        background: "var(--ink)",
                        border: "1px solid var(--line)",
                        borderRadius: 6,
                        color: "var(--silver-200)",
                        overflow: "auto",
                      }}
                    >
                      {safeStringify(call.output)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function safeStringify(value: unknown, max = 4000): string {
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? s.slice(0, max) + "\n…[truncated]" : s;
  } catch {
    return String(value);
  }
}
