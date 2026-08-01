import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWorkbench } from "../../workbench-state";
import { api } from "@/lib/api";
import { describeNextRun, validateCronSchedule } from "@/lib/agent-runtime";
import { canEditWorkflowRole, canManageWorkspaceRole } from "@/lib/roles";
import type {
  AgentInputField,
  AgentMemoryEntry,
  AgentPlaybookStep,
  AgentRecord,
  AgentRunRecord,
  AgentStatus,
  AgentTriggerKind,
  AvailableTool,
  ProviderRecord,
  SaveAgentInput,
} from "@/lib/types";
import {
  buildRunInputPayload,
  fieldValue,
  formatStepList,
  isApprovalResult,
  missingPlaybookTitleIndexes,
  runFromAgentResult,
  seedRunInputs,
  type PendingRunApproval,
  type RunAgentResult,
  type RunInputPayload,
} from "./helpers";

export function useAgentEditorController() {
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

  return {
    isNew,
    canManageAgent,
    canRunAgent,
    agent,
    runs,
    providers,
    playbook,
    triggerKind,
    schedule,
    inputSchema,
    memory,
    evaluationExpectedOutput,
    evaluationTools,
    enabledTools,
    availableTools,
    runInputs,
    webhookBusy,
    recordingRunId,
    loading,
    saving,
    exporting,
    running,
    error,
    message,
    expandedRun,
    pendingApproval,
    playbookValidationVisible,
    playbookReviewRunId,
    toolSectionRef,
    defaults,
    nextRunLabel,
    firstRunEvaluationPending,
    scheduleValidation,
    showScheduleValidation,
    saveAgent,
    archive,
    exportBundle,
    rotateWebhook,
    removeWebhook,
    recordAsPlaybook,
    updateEnabledTools,
    updateRunInputValue,
    updateInputSchema,
    updateTriggerKind,
    runNow,
    launchPendingApproval,
    editPendingTools,
    cancelPendingApproval,
    updatePlaybook,
    webhookPathToken,
    hasWebhook,
    setSchedule,
    setScheduleTouched,
    setMemory,
    setEvaluationExpectedOutput,
    setEvaluationTools,
    setExpandedRun,
    setPlaybookReviewRunId,
  };
}
