import { useEffect, useMemo, useRef, useState } from "react";
import { I, type IconKey } from "../icons";
import { api } from "@/lib/api";
import { useApiData } from "../useApiData";
import { AgentBuilderPanel } from "./builder-agent";
import { ProviderBanner } from "./builder-provider-banner";
import { BuilderTour, resetBuilderTour } from "./builder-tour";
import type {
  AppBuilderApproveResult,
  AppBuilderIterationResult,
  AppBuilderIterationTarget,
  AppBuilderCheckpointSummary,
  AppBuilderPublishState,
  BuilderModelPresetId,
  BuilderProviderStatusPayload,
} from "@/lib/types";
import { PRESET_OPTIONS } from "./builder/constants";
import {
  buildFixErrorsPrompt,
  buildIterationTargetOptions,
  describeMessageForContext,
  newId,
  nextSmarterPreset,
  stableTargetKey,
} from "./builder/helpers";
import type {
  BuilderKind,
  BuilderState,
  ChatMessage,
  Mode,
  PublishRollbackAction,
  PublishRollbackBody,
  SelectedElement,
} from "./builder/types";
import { ThreadMessage } from "./builder/thread";
import { PreviewTab } from "./builder/tabs/preview";
import { FilesTab } from "./builder/tabs/files";
import { LogsTab, SmokeTab } from "./builder/tabs/smoke-logs";
import { CheckpointsTab } from "./builder/tabs/checkpoints";
import { PublishTab } from "./builder/tabs/publish";
import { SandboxBuilderTab } from "./builder/tabs/sandbox";

export {
  buildFixErrorsPrompt,
  getPreviewNavigationTarget,
  publishPrimaryActionLabel,
  publishReadinessHeading,
} from "./builder/helpers";

export const BUILDER_STARTER_PROMPTS: Array<{ kind: BuilderKind; label: string; prompt: string }> =
  [
    {
      kind: "app",
      label: "Lightweight CRM",
      prompt:
        "Build a lightweight CRM for account managers to track companies, contacts, opportunities, and renewal risk.",
    },
    {
      kind: "app",
      label: "Customer portal",
      prompt:
        "Build a customer portal where customers can manage profile details, open requests, and upload documents.",
    },
    {
      kind: "agent",
      label: "Standup digest agent",
      prompt:
        "Build an agent that posts a daily standup digest summarising the team's overnight progress and today's plan.",
    },
    {
      kind: "agent",
      label: "Support triage agent",
      prompt:
        "Create a webhook agent to triage customer incidents, open blockers for critical risks, and post a summary to Slack.",
    },
  ];

export function shouldRouteToAgentBuilder(prompt: string): boolean {
  const text = prompt
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;

  const appSurfaceRequest =
    /\b(?:build|create|make|design|draft|configure|generate|set up|setup)\s+(?:me\s+)?(?:a|an|the)?\s*(?:[a-z0-9-]+\s+){0,3}(?:app|application|portal|dashboard|crm|website|site|tool|system)\b/;
  if (appSurfaceRequest.test(text)) return false;

  const appSurfaceAfterAgent =
    /\b(?:agent|assistant|bot|chatbot)\s+(?:app|application|portal|dashboard|crm|website|site|tool|system)\b/;
  if (appSurfaceAfterAgent.test(text)) return false;

  return [
    /\b(?:build|create|make|design|draft|configure|generate|set up|setup)\s+(?:me\s+)?(?:a|an|the)?\s*(?:ai\s+)?(?:[a-z0-9-]+\s+){0,3}(?:agent|assistant|bot|chatbot)\b/,
    /\b(?:need|want|looking for|would like)\s+(?:me\s+)?(?:a|an|the|my|our)?\s*(?:ai\s+)?(?:[a-z0-9-]+\s+){0,4}(?:agent|assistant|bot|chatbot)\b/,
    /\b(?:a|an|the|my|our)\s+(?:ai\s+)?(?:[a-z0-9-]+\s+){0,3}(?:agent|assistant|bot|chatbot)\s+(?:that|to|which)\b/,
    /\bwebhook\s+(?:agent|assistant|bot)\b/,
  ].some((pattern) => pattern.test(text));
}

export function resolveBuilderStartKind(prompt: string): BuilderKind {
  return shouldRouteToAgentBuilder(prompt) ? "agent" : "app";
}

export function builderPrimaryActionCopy(prompt: string, working: boolean): string {
  if (working) return "Generating";
  return shouldRouteToAgentBuilder(prompt) ? "Open agent builder" : "Build";
}

export function BuilderView() {
  const [mode, setMode] = useState<Mode>("empty");
  const [builderKind, setBuilderKind] = useState<BuilderKind>("app");
  const [agentAutoGenerate, setAgentAutoGenerate] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [iterPrompt, setIterPrompt] = useState("");
  const [iterTargetId, setIterTargetId] = useState<string>("app:draft");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [tab, setTab] = useState<
    "preview" | "files" | "smoke" | "logs" | "sandbox" | "checkpoints" | "publish"
  >("preview");
  const [checkpoints, setCheckpoints] = useState<AppBuilderCheckpointSummary[]>([]);
  const [publishState, setPublishState] = useState<AppBuilderPublishState | null>(null);

  const [state, setState] = useState<BuilderState>({
    draft: null,
    draftSource: null,
    generatedFiles: [],
    appId: null,
    checkpointId: null,
    previewUrl: null,
    smoke: null,
    iteration: null,
    sourceFiles: [],
    workspace: null,
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composerPreset, setComposerPreset] = useState<BuilderModelPresetId>("smart");
  // Resolved (provider, model) for each preset, computed from current env on
  // the server. Used to render the model-preset chip tooltips so users can see
  // *which* model their selection actually drives.
  const providerStatus = useApiData<BuilderProviderStatusPayload>(
    () => api.getBuilderProviderStatus(),
    [],
  );
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  // Tracks the most recent user-submitted prompt across generate / iterate, so
  // the "Try again" button on a FriendlyErrorCard can re-seed the right
  // composer. We intentionally do not auto-resubmit — letting the user review
  // and edit avoids re-triggering the same failure mode.
  const lastPromptRef = useRef<{ kind: "generate" | "iterate"; text: string } | null>(null);
  const iterationTargetOptions = useMemo(
    () => buildIterationTargetOptions(state.draft),
    [state.draft],
  );
  const selectedIterationTarget =
    iterationTargetOptions.find((target) => target.id === iterTargetId) ??
    iterationTargetOptions[0]!;
  const selectedTargetKind = selectedElement ? "page" : selectedIterationTarget.kind;
  const pageIterationTarget =
    iterationTargetOptions.find((target) => target.kind === "page") ?? selectedIterationTarget;

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!iterationTargetOptions.some((target) => target.id === iterTargetId)) {
      setIterTargetId(iterationTargetOptions[0]!.id);
    }
  }, [iterationTargetOptions, iterTargetId]);

  // Re-seed the appropriate composer when a FriendlyErrorCard fires its
  // "Try again" event. We restore the prompt text rather than auto-submit so
  // the user can edit before retrying (and so a stuck failure mode doesn't
  // immediately re-fire).
  useEffect(() => {
    const onRetry = () => {
      const last = lastPromptRef.current;
      if (!last) return;
      if (last.kind === "iterate") {
        setIterPrompt(last.text);
      } else {
        setPrompt(last.text);
      }
    };
    window.addEventListener("packetagent:retry-last-action", onRetry);
    return () => window.removeEventListener("packetagent:retry-last-action", onRetry);
  }, []);

  const appendMessage = (msg: ChatMessage) => setMessages((prev) => [...prev, msg]);
  const updateMessage = (id: string, updater: (msg: ChatMessage) => ChatMessage) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
  const pushSystemStatus = (text: string, tone: "info" | "warn" | "error" | "ok" = "info") =>
    appendMessage({ id: newId(), role: "system", body: { kind: "status", text, tone } });

  const openAgentBuilder = (nextPrompt: string, autoGenerate = false) => {
    const seededPrompt = nextPrompt.trim();
    if (!seededPrompt || working) return;
    lastPromptRef.current = null;
    setBuilderKind("agent");
    setPrompt(nextPrompt);
    setError(null);
    setMessages([]);
    setCheckpoints([]);
    setPublishState(null);
    setSelectedElement(null);
    setState({
      draft: null,
      draftSource: null,
      generatedFiles: [],
      appId: null,
      checkpointId: null,
      previewUrl: null,
      smoke: null,
      iteration: null,
      sourceFiles: [],
      workspace: null,
    });
    setAgentAutoGenerate(autoGenerate);
    setMode("agent");
  };

  const submitInitialPrompt = () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt || working) return;
    const nextKind = resolveBuilderStartKind(nextPrompt);
    setBuilderKind(nextKind);
    if (nextKind === "agent") {
      openAgentBuilder(nextPrompt, true);
      return;
    }
    void generate();
  };

  /**
   * Stamp the most recent plan/diff message that does not yet carry a checkpointId.
   * Called after `approve` / `applyIteration` succeeds so the matching chat entry
   * can render the "Revert to here" affordance.
   */
  const attachCheckpointToLatestPlanOrDiff = (checkpointId: string) =>
    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i]!;
        if (m.checkpointId) continue;
        if (m.body.kind !== "plan" && m.body.kind !== "diff") continue;
        const next = prev.slice();
        next[i] = { ...m, checkpointId };
        return next;
      }
      return prev;
    });

  // Refresh checkpoints + publish state when an app is created
  useEffect(() => {
    if (!state.appId) return;
    let mounted = true;
    void api
      .listBuilderCheckpoints({ appId: state.appId })
      .then((res) => mounted && setCheckpoints(res.checkpoints))
      .catch(() => {});
    void api
      .getBuilderPublishState({ appId: state.appId })
      .then((s) => mounted && setPublishState(s))
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [state.appId, state.checkpointId]);

  const generate = async (opts?: { presetOverride?: BuilderModelPresetId }) => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt || working) return;
    const effectivePreset = opts?.presetOverride ?? composerPreset;
    const previousMode = mode;
    lastPromptRef.current = { kind: "generate", text: nextPrompt };
    setWorking(true);
    setError(null);
    setMode("drafting");
    appendMessage({ id: newId(), role: "user", body: { kind: "text", text: nextPrompt } });
    const assistantId = newId();
    appendMessage({
      id: assistantId,
      role: "assistant",
      body: { kind: "steps", steps: [] },
      streaming: true,
    });
    try {
      await api.streamAppBuilderDraft({ prompt: nextPrompt, preset: effectivePreset }, (event) => {
        if (event.type === "step") {
          updateMessage(assistantId, (m) => {
            if (m.body.kind !== "steps") return m;
            return { ...m, body: { kind: "steps", steps: [...m.body.steps, event.text] } };
          });
        } else if (event.type === "prose") {
          updateMessage(assistantId, (m) => {
            const next = m.body.kind === "prose" ? m.body.text + event.text : event.text;
            return { ...m, body: { kind: "prose", text: next } };
          });
        } else if (event.type === "draft") {
          setPrompt(event.draft.prompt || nextPrompt);
          setState({
            draft: event.draft,
            draftSource: event.source ?? null,
            generatedFiles: event.files ?? [],
            appId: null,
            checkpointId: null,
            previewUrl: null,
            smoke: null,
            iteration: null,
            sourceFiles: event.sourceFiles ?? [],
            workspace: null,
          });
          setCheckpoints([]);
          setPublishState(null);
          setTab("preview");
          updateMessage(assistantId, (m) => ({
            ...m,
            body: { kind: "plan", draft: event.draft },
            streaming: false,
          }));
          setMode("drafted");
          if (event.validationErrors && event.validationErrors.length > 0) {
            appendMessage({
              id: newId(),
              role: "assistant",
              body: { kind: "validation-errors", errors: event.validationErrors, canFix: true },
            });
          }
        } else if (event.type === "validation") {
          if (event.errors.length > 0) {
            appendMessage({
              id: newId(),
              role: "assistant",
              body: { kind: "validation-errors", errors: event.errors, canFix: true },
            });
          }
        } else if (event.type === "error") {
          setError(event.error);
          updateMessage(assistantId, (m) => ({
            ...m,
            body: { kind: "status", text: event.error, tone: "error" },
            streaming: false,
          }));
          setMode(previousMode);
        }
      });
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      updateMessage(assistantId, (m) => ({
        ...m,
        body: { kind: "status", text: message, tone: "error" },
        streaming: false,
      }));
      setMode(previousMode);
    } finally {
      setWorking(false);
    }
  };

  const approve = async () => {
    if (!state.draft || working) return;
    setWorking(true);
    setError(null);
    setMode("applying");
    try {
      const currentGeneratedFiles = state.generatedFiles;
      const currentDraftSource = state.draftSource;
      const result: AppBuilderApproveResult = await api.approveAppBuilderDraft({
        prompt: state.draft.prompt,
        draft: state.draft,
        source: currentDraftSource ?? undefined,
        files: currentGeneratedFiles.length > 0 ? currentGeneratedFiles : undefined,
        runBuild: true,
        runSmoke: true,
        targetStatus: "built",
      });
      setState({
        draft: result.draft,
        draftSource: result.draftSource ?? currentDraftSource,
        generatedFiles: result.fileTree ?? currentGeneratedFiles,
        appId: result.app?.id ?? null,
        checkpointId: result.checkpoint?.id ?? null,
        previewUrl: result.previewUrl ?? result.app?.previewUrl ?? null,
        smoke: result.smoke ?? result.smokeBuild ?? null,
        iteration: null,
        sourceFiles: result.sourceFiles ?? result.artifact?.files ?? [],
        workspace: result.workspace ?? null,
      });
      const newCheckpointId = result.checkpoint?.id;
      if (newCheckpointId) attachCheckpointToLatestPlanOrDiff(newCheckpointId);
      setMode("applied");
      setTab("preview");
      const smokeStatus = result.smoke?.status ?? result.smokeBuild?.status;
      pushSystemStatus(
        smokeStatus === "pass"
          ? "Draft applied. Smoke checks passed."
          : `Draft applied${smokeStatus ? `. Smoke: ${smokeStatus}.` : "."}`,
        smokeStatus === "fail" ? "warn" : "ok",
      );
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      pushSystemStatus(message, "error");
      setMode("drafted");
    } finally {
      setWorking(false);
    }
  };

  const iterate = async (
    promptOverride?: string,
    opts?: { presetOverride?: BuilderModelPresetId },
  ) => {
    const effectivePrompt = promptOverride ?? iterPrompt;
    if (!state.draft || !effectivePrompt.trim() || working) return;
    const effectivePreset = opts?.presetOverride ?? composerPreset;
    const baseTarget = selectedElement ? pageIterationTarget : selectedIterationTarget;
    const target: AppBuilderIterationTarget = selectedElement
      ? {
          ...baseTarget,
          id: `${baseTarget.id}:element:${stableTargetKey(selectedElement.selector)}`,
          kind: "page",
          label: `${baseTarget.label} -> ${selectedElement.selector}`,
          path: selectedElement.selector,
        }
      : baseTarget;
    const composedPrompt = selectedElement
      ? `On the element \`${selectedElement.selector}\`${selectedElement.label ? ` ("${selectedElement.label}")` : ""}: ${effectivePrompt}`
      : effectivePrompt;
    lastPromptRef.current = { kind: "iterate", text: effectivePrompt };
    setWorking(true);
    setError(null);
    setMode("iterating");
    appendMessage({ id: newId(), role: "user", body: { kind: "text", text: composedPrompt } });
    const assistantId = newId();
    appendMessage({
      id: assistantId,
      role: "assistant",
      body: { kind: "steps", steps: [] },
      streaming: true,
    });
    setIterPrompt("");
    setSelectedElement(null);
    try {
      await api.streamAppBuilderIteration(
        {
          appId: state.appId ?? undefined,
          checkpointId: state.checkpointId ?? undefined,
          draft: state.draft,
          draftSource: state.draftSource ?? undefined,
          fileTree: state.generatedFiles.length > 0 ? state.generatedFiles : undefined,
          target,
          prompt: composedPrompt,
          preset: effectivePreset,
        },
        (event) => {
          if (event.type === "step") {
            updateMessage(assistantId, (m) => {
              if (m.body.kind !== "steps") return m;
              return { ...m, body: { kind: "steps", steps: [...m.body.steps, event.text] } };
            });
          } else if (event.type === "prose") {
            updateMessage(assistantId, (m) => {
              const next = m.body.kind === "prose" ? m.body.text + event.text : event.text;
              return { ...m, body: { kind: "prose", text: next } };
            });
          } else if (event.type === "diff") {
            setState((prev) => ({ ...prev, iteration: event.iteration }));
            updateMessage(assistantId, (m) => ({
              ...m,
              body: { kind: "diff", iteration: event.iteration },
              streaming: false,
            }));
            setMode("applied");
          } else if (event.type === "validation") {
            if (event.errors.length > 0) {
              appendMessage({
                id: newId(),
                role: "assistant",
                body: { kind: "validation-errors", errors: event.errors, canFix: true },
              });
            }
          } else if (event.type === "error") {
            setError(event.error);
            updateMessage(assistantId, (m) => ({
              ...m,
              body: { kind: "status", text: event.error, tone: "error" },
              streaming: false,
            }));
            setMode("applied");
          }
        },
      );
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      updateMessage(assistantId, (m) => ({
        ...m,
        body: { kind: "status", text: message, tone: "error" },
        streaming: false,
      }));
      setMode("applied");
    } finally {
      setWorking(false);
    }
  };

  const applyIteration = async () => {
    if (!state.iteration || working) return;
    setWorking(true);
    setError(null);
    try {
      const result = await api.applyAppBuilderIterationDiff({
        appId: state.appId ?? undefined,
        checkpointId: state.checkpointId ?? undefined,
        diffId: state.iteration.id,
        target: state.iteration.target,
        files: state.iteration.files,
        diff: state.iteration,
        draft: state.iteration.draft ?? state.draft ?? undefined,
        runBuild: true,
        runSmoke: true,
        refreshPreview: true,
      });
      setState((prev) => ({
        ...prev,
        draft: result.diff?.draft ?? prev.draft,
        draftSource: result.diff?.draftSource ?? result.draftSource ?? prev.draftSource,
        generatedFiles: result.diff?.fileTree ?? result.fileTree ?? prev.generatedFiles,
        appId: result.app?.id ?? prev.appId,
        checkpointId: result.checkpoint?.id ?? prev.checkpointId,
        previewUrl:
          result.preview?.previewUrl ??
          result.previewUrl ??
          result.app?.previewUrl ??
          prev.previewUrl,
        smoke: result.smoke ?? prev.smoke,
        iteration: null,
        sourceFiles:
          result.sourceFiles ??
          result.diff?.sourceFiles ??
          result.diff?.artifact?.files ??
          prev.sourceFiles,
        workspace: result.workspace ?? prev.workspace,
      }));
      const newCheckpointId = result.checkpoint?.id;
      if (newCheckpointId) attachCheckpointToLatestPlanOrDiff(newCheckpointId);
      setIterPrompt("");
      pushSystemStatus("Diff applied. Preview refreshed.", "ok");
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      pushSystemStatus(message, "error");
    } finally {
      setWorking(false);
    }
  };

  const rollback = async (checkpointId: string) => {
    if (!state.appId || working) return;
    setWorking(true);
    setError(null);
    try {
      const result = await api.rollbackBuilderCheckpoint(checkpointId, { appId: state.appId });
      setState((prev) => ({
        ...prev,
        draft: result.draft ?? prev.draft,
        appId: result.app?.id ?? prev.appId,
        checkpointId: result.checkpoint?.id ?? prev.checkpointId,
        previewUrl: result.preview?.url ?? result.app?.previewUrl ?? prev.previewUrl,
        smoke: result.smoke ?? prev.smoke,
        iteration: null,
        generatedFiles: result.fileTree ?? prev.generatedFiles,
        draftSource: result.draftSource ?? prev.draftSource,
        sourceFiles: result.sourceFiles ?? result.artifact?.files ?? prev.sourceFiles,
        workspace: prev.workspace,
      }));
      setSelectedElement(null);
      setMode("applied");
      setTab("preview");
      const nextAppId = result.app?.id ?? state.appId;
      const cps = await api.listBuilderCheckpoints({ appId: nextAppId });
      setCheckpoints(cps.checkpoints);
      try {
        const ps = await api.getBuilderPublishState({
          appId: nextAppId,
          checkpointId: result.checkpoint?.id,
        });
        setPublishState(ps);
      } catch {
        /* ignore */
      }
      pushSystemStatus(result.preview?.message ?? "Save restored.", "ok");
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      pushSystemStatus(message, "error");
    } finally {
      setWorking(false);
    }
  };

  const branch = async (checkpointId: string) => {
    if (!state.appId || working) return;
    const sourceCheckpointShort = checkpointId.slice(0, 12);
    const sourceAppName = state.draft?.app.name ?? "the source app";
    setWorking(true);
    setError(null);
    try {
      const result = await api.branchBuilderCheckpoint(checkpointId, { appId: state.appId });
      setState({
        draft: result.draft,
        draftSource: null,
        generatedFiles: [],
        appId: result.app.id,
        checkpointId: result.checkpoint.id,
        previewUrl: result.app.previewUrl ?? null,
        smoke: result.smoke ?? null,
        iteration: null,
        sourceFiles: [],
        workspace: null,
      });
      setMessages([]);
      setSelectedElement(null);
      setTab("preview");
      setMode("applied");
      pushSystemStatus(`Branched from ${sourceCheckpointShort} in '${sourceAppName}'.`, "info");
      try {
        const cps = await api.listBuilderCheckpoints({ appId: result.app.id });
        setCheckpoints(cps.checkpoints);
      } catch {
        /* ignore */
      }
      try {
        const ps = await api.getBuilderPublishState({ appId: result.app.id });
        setPublishState(ps);
      } catch {
        /* ignore */
      }
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      pushSystemStatus(message, "error");
    } finally {
      setWorking(false);
    }
  };

  const publish = async () => {
    if (!state.appId || working) return;
    setWorking(true);
    setError(null);
    try {
      const result = await api.publishBuilderApp({
        appId: state.appId,
        checkpointId: state.checkpointId ?? undefined,
        runBuild: true,
        runSmoke: true,
      });
      setPublishState(result.state);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const rollbackPublish = async (action: PublishRollbackAction) => {
    if (!state.appId || !publishState || working) return;
    if (!action.publishId) {
      const message = "Publish rollback action is missing a target publish id.";
      setError(message);
      pushSystemStatus(message, "error");
      return;
    }
    const currentPublishId = publishState.history.find(
      (entry) =>
        !publishState.rollbackActions.some(
          (rollbackAction) => rollbackAction.publishId === entry.id,
        ),
    )?.id;
    if (!currentPublishId) {
      const message = "Current publish id could not be resolved for rollback.";
      setError(message);
      pushSystemStatus(message, "error");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const body: PublishRollbackBody = {
        appId: state.appId,
        checkpointId: action.checkpointId,
        targetPublishId: action.publishId,
        reason: `Rollback via builder publish panel to ${action.label}.`,
      };
      const result = await api.rollbackBuilderPublish(currentPublishId, body);
      setPublishState(result.state);
      setState((prev) => ({
        ...prev,
        checkpointId: result.state.checkpointId ?? action.checkpointId ?? prev.checkpointId,
        iteration: null,
      }));
      pushSystemStatus(`${action.label} complete.`, "ok");
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      pushSystemStatus(message, "error");
    } finally {
      setWorking(false);
    }
  };

  const draft = state.draft;

  return (
    <>
      <BuilderTour />
      <header className="flex items-center justify-between px-4 h-10 border-b border-line text-sm">
        <div className="flex items-center gap-2">
          {state.appId ? (
            <a
              href="/builder"
              className="text-silver-400 hover:text-silver-50"
              aria-label="Back to builder"
            >
              ‹
            </a>
          ) : (
            <a href="/" className="text-silver-400 hover:text-silver-50" aria-label="Back to home">
              ‹
            </a>
          )}
          <span className="text-silver-50">
            {state.draft?.app.name ??
              (builderKind === "agent" && mode === "agent" ? "New agent" : "New build")}
          </span>
        </div>
        <span className="text-silver-400">⋯</span>
      </header>

      {mode === "empty" && (
        <div className="flex flex-col items-center justify-center min-h-[calc(100vh-40px)] px-6">
          <ProviderBanner />
          <h1 className="text-[28px] font-medium text-silver-50 mb-6">
            What do you want to build today?
          </h1>

          <div
            data-tour="composer"
            className="mx-auto w-full max-w-[720px] rounded-2xl border border-line bg-panel/60 backdrop-blur-sm focus-within:border-green-deep/60 transition"
          >
            <textarea
              placeholder="Describe what you want to build..."
              className="w-full resize-none bg-transparent px-5 pt-5 pb-2 text-[16px] leading-relaxed placeholder:text-silver-500 focus:outline-none min-h-[112px]"
              value={prompt}
              onChange={(event) => {
                const nextPrompt = event.target.value;
                setPrompt(nextPrompt);
                setBuilderKind(resolveBuilderStartKind(nextPrompt));
              }}
            />
            <div className="flex items-center justify-between px-3 pb-3">
              {/* TODO Phase 2: kind + preset popover */}
              <button
                type="button"
                data-tour="presets"
                className="text-silver-400 hover:text-silver-50 px-2 py-1"
                aria-label="Build options"
                title="Coming in a future update: pick app vs agent and tweak the model preset"
              >
                ⚙
              </button>
              <button
                className="btn-primary btn"
                disabled={!prompt.trim() || working}
                onClick={submitInitialPrompt}
              >
                {working ? (
                  <>
                    <span className="spin">
                      <I.refresh size={13} />
                    </span>{" "}
                    {builderPrimaryActionCopy(prompt, working)}
                  </>
                ) : (
                  <>
                    {resolveBuilderStartKind(prompt) === "agent" ? (
                      <I.bot size={13} />
                    ) : (
                      <I.arrowUp size={13} />
                    )}{" "}
                    {builderPrimaryActionCopy(prompt, working)}
                  </>
                )}
              </button>
            </div>
          </div>

          <div
            data-tour="chips"
            className="mt-4 grid grid-cols-2 gap-2 max-w-[720px] mx-auto w-full"
          >
            {BUILDER_STARTER_PROMPTS.map((starter) => (
              <button
                key={starter.label}
                type="button"
                className="rounded-xl border border-line bg-panel/40 px-4 py-3 text-left text-sm hover:border-green-deep/40 hover:bg-panel transition"
                onClick={() => {
                  if (starter.kind === "agent") {
                    openAgentBuilder(starter.prompt);
                  } else {
                    setBuilderKind("app");
                    setPrompt(starter.prompt);
                  }
                }}
              >
                {starter.label}
              </button>
            ))}
          </div>

          <div className="mt-3 max-w-[720px] mx-auto w-full flex justify-center">
            <button
              type="button"
              className="text-silver-500 hover:text-silver-300 text-xs underline underline-offset-2"
              onClick={() => {
                resetBuilderTour();
                // Force a remount so the tour picks up the cleared flag.
                if (typeof window !== "undefined") window.location.reload();
              }}
            >
              Show tour
            </button>
          </div>

          {error && (
            <div
              className="card max-w-[720px] mx-auto w-full"
              style={{
                padding: "10px 14px",
                marginTop: 14,
                borderColor: "rgba(242,107,92,0.3)",
                color: "var(--danger)",
              }}
            >
              <span className="mono" style={{ fontSize: 11.5 }}>
                ERR · {error}
              </span>
            </div>
          )}
        </div>
      )}

      {builderKind === "agent" && mode !== "empty" && (
        <AgentBuilderPanel initialPrompt={prompt} embedded autoGenerate={agentAutoGenerate} />
      )}

      {(mode === "drafted" || mode === "applying" || mode === "applied" || mode === "iterating") &&
        draft && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(440px, 520px) 1fr",
              gridTemplateRows: "1fr",
              height: "calc(100vh - 52px)",
            }}
          >
            <aside
              style={{
                borderRight: "1px solid var(--line)",
                display: "flex",
                flexDirection: "column",
                background: "var(--bg-elev)",
                minWidth: 0,
                minHeight: 0,
              }}
            >
              <div
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--line)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <I.layout size={15} style={{ color: "var(--green)", flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    className="h3"
                    style={{
                      fontSize: 14,
                      color: "var(--silver-50)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {draft.app.name}
                  </div>
                  <div
                    className="mono muted"
                    style={{
                      fontSize: 10.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    /{draft.app.slug} · {draft.app.pages.length}p · {draft.app.dataSchema.length}e ·{" "}
                    {draft.app.apiRoutes.length}r
                  </div>
                </div>
                {state.appId ? (
                  <span className="pill good" style={{ flexShrink: 0 }}>
                    <span className="dot"></span>saved preview
                  </span>
                ) : (
                  <span className="pill warn" style={{ flexShrink: 0 }}>
                    <span className="dot"></span>draft
                  </span>
                )}
              </div>

              <div
                ref={threadRef}
                style={{
                  flex: 1,
                  overflow: "auto",
                  padding: "14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}
              >
                {messages.map((msg) => (
                  <ThreadMessage
                    key={msg.id}
                    message={msg}
                    preset={composerPreset}
                    onApplyIteration={() => {
                      void applyIteration();
                    }}
                    onRevert={(checkpointId) => {
                      void rollback(checkpointId);
                    }}
                    onFixErrors={(errors) => {
                      const fixPrompt = buildFixErrorsPrompt(errors);
                      setIterPrompt(fixPrompt);
                      void iterate(fixPrompt);
                    }}
                    onTrySmarter={(messageId) => {
                      const target = messages.find((m) => m.id === messageId);
                      if (!target) return;
                      const nextPreset = nextSmarterPreset(composerPreset);
                      if (!nextPreset) return;
                      setComposerPreset(nextPreset);
                      if (target.body.kind === "plan") {
                        // Re-run draft generation at the smarter tier using the current
                        // prompt. We pass the preset directly so we never depend on the
                        // setComposerPreset state update having flushed first.
                        void generate({ presetOverride: nextPreset });
                      } else if (target.body.kind === "diff") {
                        // Reuse the prompt from the user message immediately preceding
                        // this assistant diff so a retry mirrors the original turn.
                        const idx = messages.findIndex((m) => m.id === messageId);
                        let priorPrompt = "";
                        for (let i = idx - 1; i >= 0; i--) {
                          const prev = messages[i]!;
                          if (prev.role === "user" && prev.body.kind === "text") {
                            priorPrompt = prev.body.text;
                            break;
                          }
                        }
                        if (!priorPrompt) return;
                        void iterate(priorPrompt, { presetOverride: nextPreset });
                      }
                    }}
                    onTellMeWhatToChange={(messageId) => {
                      const target = messages.find((m) => m.id === messageId);
                      const summary = describeMessageForContext(target);
                      const contextLine = summary
                        ? `About this change (${summary}): `
                        : `About this change: `;
                      // Iteration composer exists post-draft. If we have a draft, prepend
                      // to iterPrompt and focus the post-draft textarea. Otherwise focus
                      // the main (cold-start) composer.
                      if (state.draft) {
                        setIterPrompt((prev) =>
                          prev.startsWith(contextLine) ? prev : contextLine + prev,
                        );
                        // After the state update commits, focus the iteration textarea.
                        // We look it up via placeholder match so we never have to edit the
                        // composer section to add a ref.
                        requestAnimationFrame(() => {
                          const composer = document.querySelector<HTMLTextAreaElement>(
                            'textarea.field[placeholder^="Refine"], textarea.field[placeholder^="Tell me what to change"]',
                          );
                          if (composer) {
                            composer.focus();
                            const len = composer.value.length;
                            composer.setSelectionRange(len, len);
                          }
                        });
                      } else {
                        setPrompt((prev) =>
                          prev.startsWith(contextLine) ? prev : contextLine + prev,
                        );
                        requestAnimationFrame(() => {
                          const composer =
                            document.querySelector<HTMLTextAreaElement>("textarea.field");
                          if (composer) {
                            composer.focus();
                            const len = composer.value.length;
                            composer.setSelectionRange(len, len);
                          }
                        });
                      }
                    }}
                    working={working}
                  />
                ))}

                {!state.appId && mode === "drafted" && state.draft && (
                  <div
                    className="card"
                    style={{
                      padding: 14,
                      marginLeft: 30,
                      background: "var(--bg-elev)",
                      borderColor: "var(--green-deep)",
                    }}
                  >
                    <div className="kicker" style={{ marginBottom: 6, color: "var(--green)" }}>
                      Ready to approve
                    </div>
                    <p className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
                      Approving saves generated source metadata, runs build + smoke checks, and
                      creates a checkpoint.
                    </p>
                    <button
                      className="btn btn-primary"
                      disabled={working}
                      onClick={() => {
                        void approve();
                      }}
                    >
                      {working ? (
                        <span className="spin">
                          <I.refresh size={13} />
                        </span>
                      ) : (
                        <I.check size={13} />
                      )}
                      {working ? " Applying…" : " Approve"}
                    </button>
                  </div>
                )}
              </div>

              <div
                style={{ padding: 12, borderTop: "1px solid var(--line)", background: "var(--bg)" }}
              >
                {!state.appId && mode === "drafted" && state.draft && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 12px",
                      marginBottom: 10,
                      background: "rgba(184,242,92,0.08)",
                      border: "1px solid var(--green-deep)",
                      borderRadius: 8,
                    }}
                  >
                    <I.check size={14} style={{ color: "var(--green)", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--silver-50)" }}>
                        Ready to approve
                      </div>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        Saves the source, runs quality checks, and creates a save.
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      disabled={working}
                      onClick={() => {
                        void approve();
                      }}
                    >
                      {working ? (
                        <span className="spin">
                          <I.refresh size={13} />
                        </span>
                      ) : (
                        <I.check size={13} />
                      )}
                      {working ? " Applying…" : " Approve"}
                    </button>
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                  {iterationTargetOptions.map((t) => {
                    const active = selectedIterationTarget.id === t.id && !selectedElement;
                    return (
                      <button
                        key={t.id}
                        className="btn btn-sm"
                        title={t.group}
                        onClick={() => {
                          setIterTargetId(t.id);
                          setSelectedElement(null);
                        }}
                        style={{
                          background: active ? "var(--bg-elev)" : "var(--panel)",
                          borderColor: active ? "var(--green-deep)" : "var(--line-2)",
                          color: active ? "var(--green)" : "var(--silver-300)",
                          fontSize: 11,
                        }}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
                {selectedElement && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      marginBottom: 8,
                      background: "rgba(184,242,92,0.08)",
                      border: "1px solid rgba(184,242,92,0.3)",
                      borderRadius: 8,
                      fontSize: 11.5,
                      color: "var(--green)",
                    }}
                  >
                    <I.zap size={11} />
                    <span
                      className="mono"
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Editing: {selectedElement.selector}
                      {selectedElement.label && (
                        <span style={{ color: "var(--silver-300)" }}>
                          {" "}
                          · "{selectedElement.label}"
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => setSelectedElement(null)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--silver-300)",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      <I.close size={11} />
                    </button>
                  </div>
                )}
                <div style={{ position: "relative" }}>
                  <textarea
                    className="field"
                    placeholder={
                      selectedElement
                        ? "Tell me what to change about that element"
                        : state.appId
                          ? "Refine — e.g. 'add inline notes' or 'fix smoke check'"
                          : "Refine — what should change next?"
                    }
                    value={iterPrompt}
                    onChange={(e) => setIterPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        (e.metaKey || e.ctrlKey) &&
                        iterPrompt.trim() &&
                        !working
                      ) {
                        e.preventDefault();
                        void iterate();
                      }
                    }}
                    style={{ paddingRight: 80, minHeight: 64 }}
                  />
                  <div
                    style={{ position: "absolute", right: 8, bottom: 8, display: "flex", gap: 4 }}
                  >
                    <button
                      className="btn-primary btn btn-sm"
                      disabled={!iterPrompt.trim() || working}
                      onClick={() => {
                        void iterate();
                      }}
                    >
                      {working ? (
                        <span className="spin">
                          <I.refresh size={11} />
                        </span>
                      ) : (
                        <I.arrowUp size={12} />
                      )}
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    marginTop: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  {PRESET_OPTIONS.map((p) => {
                    const active = composerPreset === p.id;
                    const resolution = providerStatus.data?.presets[p.id] ?? null;
                    const tooltip = resolution
                      ? `${p.friendly} — ${resolution.provider}/${resolution.model}${resolution.local ? " (local)" : ""}`
                      : providerStatus.loading
                        ? `${p.friendly} — resolving…`
                        : `${p.friendly} — no provider configured (template fallback)`;
                    return (
                      <button
                        key={p.id}
                        onClick={() => setComposerPreset(p.id)}
                        title={tooltip}
                        style={{
                          padding: "3px 9px",
                          borderRadius: 999,
                          border: `1px solid ${active ? "var(--green-deep)" : "var(--line-2)"}`,
                          background: active ? "rgba(184,242,92,0.08)" : "transparent",
                          color: active
                            ? "var(--green)"
                            : resolution
                              ? "var(--silver-300)"
                              : "var(--silver-500)",
                          fontFamily: "var(--font-mono)",
                          fontSize: 10.5,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          cursor: "pointer",
                          opacity: resolution ? 1 : 0.7,
                        }}
                      >
                        {p.label}
                        {resolution && (
                          <span
                            style={{
                              marginLeft: 4,
                              opacity: 0.6,
                              textTransform: "lowercase",
                              letterSpacing: 0,
                            }}
                          >
                            · {resolution.provider}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  <span className="mono muted" style={{ marginLeft: "auto", fontSize: 10.5 }}>
                    ⌘↵ to send
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginTop: 6,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <span className="pill muted">target: {selectedTargetKind}</span>
                  {state.smoke && (
                    <span
                      className={`pill ${state.smoke.status === "pass" ? "good" : state.smoke.status === "fail" ? "danger" : "warn"}`}
                    >
                      <span className="dot"></span>build {state.smoke.status}
                    </span>
                  )}
                </div>
              </div>
            </aside>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                minHeight: 0,
              }}
            >
              <div className="tabbar">
                {(
                  [
                    {
                      id: "preview",
                      label: "Local preview",
                      icon: "eye" as IconKey,
                      title: "See your app running in a live iframe",
                    },
                    {
                      id: "files",
                      label: "Source",
                      icon: "code" as IconKey,
                      count: state.iteration?.files.length ?? 0,
                      title: "Browse the generated source files",
                    },
                    {
                      id: "smoke",
                      label: "Quality",
                      icon: "shield" as IconKey,
                      title: "TypeScript and build checks for your generated code",
                    },
                    {
                      id: "logs",
                      label: "Activity",
                      icon: "activity" as IconKey,
                      count: state.iteration?.logs.length ?? 0,
                      title: "Streaming logs from the most recent iteration",
                    },
                    {
                      id: "sandbox",
                      label: "Runs",
                      icon: "cpu" as IconKey,
                      title: "Sandbox execution history for this app",
                    },
                    {
                      id: "checkpoints",
                      label: "Saves",
                      icon: "history" as IconKey,
                      count: checkpoints.length,
                      title: "Every approved change is a save you can revert to",
                    },
                    {
                      id: "publish",
                      label: "Publish",
                      icon: "rocket" as IconKey,
                      title: "Generate a Docker Compose bundle to deploy this app",
                    },
                  ] as const
                ).map((t) => {
                  const Ico = I[t.icon];
                  const tourId =
                    t.id === "preview"
                      ? "preview-tab"
                      : t.id === "checkpoints"
                        ? "checkpoints"
                        : undefined;
                  return (
                    <div
                      key={t.id}
                      data-tour={tourId}
                      className={`tab ${tab === t.id ? "active" : ""}`}
                      title={t.title}
                      onClick={() => setTab(t.id)}
                    >
                      <Ico size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />
                      {t.label}
                      {"count" in t && t.count !== undefined && t.count > 0 && (
                        <span className="mono muted" style={{ fontSize: 10.5, marginLeft: 6 }}>
                          · {t.count}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ flex: 1, overflow: "auto" }}>
                {tab === "preview" && (
                  <PreviewTab
                    draft={draft}
                    appId={state.appId}
                    previewUrl={state.previewUrl}
                    onSelectElement={(sel) => setSelectedElement(sel)}
                    selectedSelector={selectedElement?.selector ?? null}
                  />
                )}
                {tab === "files" && (
                  <FilesTab
                    draft={draft}
                    iteration={state.iteration}
                    sourceFiles={state.sourceFiles}
                    workspace={state.workspace}
                  />
                )}
                {tab === "smoke" && <SmokeTab smoke={state.smoke ?? draft.smokeBuildStatus} />}
                {tab === "logs" && <LogsTab iteration={state.iteration} />}
                {tab === "sandbox" && (
                  <SandboxBuilderTab
                    appId={state.appId}
                    appName={state.draft?.app?.name ?? "App"}
                  />
                )}
                {tab === "checkpoints" && (
                  <CheckpointsTab
                    checkpoints={checkpoints}
                    currentId={state.checkpointId}
                    onRollback={(id) => {
                      void rollback(id);
                    }}
                    onBranch={(id) => {
                      void branch(id);
                    }}
                    working={working}
                  />
                )}
                {tab === "publish" && (
                  <PublishTab
                    state={publishState}
                    canPublish={!!state.appId}
                    onPublish={() => {
                      void publish();
                    }}
                    onRollback={(action) => {
                      void rollbackPublish(action);
                    }}
                    working={working}
                  />
                )}
              </div>
            </div>
          </div>
        )}

      {(mode === "drafting" || mode === "applying") && (
        <div
          style={{
            position: "fixed",
            top: 60,
            right: 28,
            padding: "10px 14px",
            background: "var(--panel)",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--green)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            zIndex: 50,
          }}
        >
          <span className="spin">
            <I.refresh size={12} />
          </span>
          {mode === "drafting" ? "Generating draft…" : "Applying changes…"}
        </div>
      )}

      {error && (mode === "drafted" || mode === "applied" || mode === "iterating") && (
        <div
          style={{
            position: "fixed",
            bottom: 20,
            right: 28,
            padding: "10px 14px",
            background: "rgba(242,107,92,0.1)",
            border: "1px solid rgba(242,107,92,0.3)",
            borderRadius: 8,
            fontSize: 11.5,
            color: "var(--danger)",
            maxWidth: 320,
            zIndex: 50,
          }}
        >
          <span className="mono">ERR · {error}</span>
        </div>
      )}
    </>
  );
}
