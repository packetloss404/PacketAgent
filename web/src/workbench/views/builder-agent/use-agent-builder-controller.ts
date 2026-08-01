import { api } from "@/lib/api";
import {
  type AgentBuilderApproveResult,
  type AgentBuilderDraft,
  type AgentInputField,
  type AgentMemoryEntry,
  type AgentRecord,
  type AgentRunRecord,
  type BuilderModelPresetId,
  type ToolCapabilityApprovalRequest,
} from "@/lib/types";
import {
  type AgentBuilderSampleInputs,
  coerceSampleValue,
  sampleInputIssuesForDraft,
  sampleInputsForDraft,
} from "../builder-agent-utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

type BuilderMode = "empty" | "drafting" | "drafted" | "saving" | "saved";

interface AgentBuilderControllerOptions {
  initialPrompt: string;
  autoGenerate: boolean;
  preset: BuilderModelPresetId;
  onAgentSaved?: (agent: AgentRecord, result: AgentBuilderApproveResult) => void;
}

export function useAgentBuilderController({
  initialPrompt,
  autoGenerate,
  preset,
  onAgentSaved,
}: AgentBuilderControllerOptions) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<BuilderMode>("empty");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [draft, setDraft] = useState<AgentBuilderDraft | null>(null);
  const [sampleInputs, setSampleInputs] = useState<AgentBuilderSampleInputs>({});
  const [runPreview, setRunPreview] = useState(true);
  const [savedAgent, setSavedAgent] = useState<AgentRecord | null>(null);
  const [firstRun, setFirstRun] = useState<AgentRunRecord | null>(null);
  const [firstRunApproval, setFirstRunApproval] = useState<ToolCapabilityApprovalRequest | null>(
    null,
  );
  const [firstRunRunning, setFirstRunRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoGenerateStarted = useRef(false);

  const working = mode === "drafting" || mode === "saving";
  const schemaByKey = useMemo(() => {
    const map = new Map<string, AgentInputField>();
    for (const field of draft?.agent.inputSchema ?? []) map.set(field.key, field);
    return map;
  }, [draft]);
  const sampleInputIssues = useMemo(
    () => (draft ? sampleInputIssuesForDraft(draft, sampleInputs) : []),
    [draft, sampleInputs],
  );

  const generateDraft = useCallback(async () => {
    if (!prompt.trim() || working) return;
    setError(null);
    setSavedAgent(null);
    setFirstRun(null);
    setFirstRunApproval(null);
    setMode("drafting");
    try {
      const nextDraft = await api.generateAgentBuilderDraft({
        prompt: prompt.trim(),
        preset,
      });
      const nextSampleInputs = sampleInputsForDraft(nextDraft);
      setDraft(nextDraft);
      setSampleInputs(nextSampleInputs);
      setRunPreview(
        nextDraft.readiness.firstRun.canRun &&
          sampleInputIssuesForDraft(nextDraft, nextSampleInputs).length === 0,
      );
      setMode("drafted");
    } catch (e) {
      setError((e as Error).message);
      setMode(draft ? "drafted" : "empty");
    }
  }, [draft, preset, prompt, working]);

  useEffect(() => {
    if (
      !autoGenerate ||
      autoGenerateStarted.current ||
      !prompt.trim() ||
      working ||
      draft ||
      savedAgent
    )
      return;
    autoGenerateStarted.current = true;
    void generateDraft();
  }, [autoGenerate, draft, generateDraft, prompt, savedAgent, working]);

  const approveDraft = async () => {
    if (!draft || working) return;
    setError(null);
    setMode("saving");
    try {
      const result = await api.approveAgentBuilderDraft({
        prompt: prompt.trim() || draft.prompt,
        draft,
        status: "active",
        runPreview: runPreview && draft.readiness.firstRun.canRun && sampleInputIssues.length === 0,
        sampleInputs,
      });
      setDraft(result.draft);
      setSampleInputs(
        (result.sampleInputs as AgentBuilderSampleInputs | undefined) ??
          sampleInputsForDraft(result.draft),
      );
      setSavedAgent(result.agent ?? null);
      setFirstRun(result.firstRun ?? null);
      setFirstRunApproval(result.firstRunApproval ?? null);
      if (result.agent) onAgentSaved?.(result.agent, result);
      setMode("saved");
    } catch (e) {
      setError((e as Error).message);
      setMode("drafted");
    }
  };

  const updateSample = (key: string, value: string | boolean) => {
    const field = schemaByKey.get(key);
    setSampleInputs((prev) => ({ ...prev, [key]: coerceSampleValue(field, value) }));
  };

  const updateMemory = (memory: AgentMemoryEntry[]) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            agent: { ...current.agent, memory },
          }
        : current,
    );
  };

  const updateExpectedOutput = (expectedOutput: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            agent: {
              ...current.agent,
              evaluationSpec: {
                expectedOutput,
                requiredTools: current.agent.evaluationSpec?.requiredTools ?? [],
              },
            },
          }
        : current,
    );
  };

  const launchFirstRun = async () => {
    if (!savedAgent || !firstRunApproval || firstRunRunning) return;
    setFirstRunRunning(true);
    setError(null);
    try {
      const result = await api.runAgent(savedAgent.id, {
        triggerKind: "manual",
        inputs: sampleInputs,
        evaluation: { kind: "first_run" },
        toolApproval: {
          decision: "launch",
          token: firstRunApproval.approvalToken,
          approvedTools: firstRunApproval.tools.map((tool) => tool.name),
        },
      });
      if (result.approval) {
        setFirstRunApproval(result.approval);
        return;
      }
      setFirstRun(result.run);
      setFirstRunApproval(null);
    } catch (launchError) {
      setError((launchError as Error).message);
    } finally {
      setFirstRunRunning(false);
    }
  };

  return {
    navigate,
    mode,
    prompt,
    setPrompt,
    draft,
    sampleInputs,
    runPreview,
    setRunPreview,
    savedAgent,
    firstRun,
    firstRunApproval,
    setFirstRunApproval,
    firstRunRunning,
    error,
    working,
    sampleInputIssues,
    generateDraft,
    approveDraft,
    updateSample,
    updateMemory,
    updateExpectedOutput,
    launchFirstRun,
  };
}
