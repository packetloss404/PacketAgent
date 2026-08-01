import { api } from "@/lib/api";
import { buildIterationTargetOptions, newId, stableTargetKey, upsertFileProgress } from "./helpers";
import { resolveBuilderStartKind } from "../builder-start";
import {
  type AppBuilderApproveResult,
  type AppBuilderCheckpointSummary,
  type AppBuilderFileProgress,
  type AppBuilderIterationTarget,
  type AppBuilderPublishState,
  type BuilderModelPresetId,
  type BuilderProviderStatusPayload,
} from "@/lib/types";
import {
  type BuilderKind,
  type BuilderState,
  type ChatMessage,
  type Mode,
  type PublishRollbackAction,
  type PublishRollbackBody,
  type SelectedElement,
} from "./types";
import { useApiData } from "../../useApiData";
import { useEffect, useMemo, useRef, useState } from "react";

export function useBuilderController() {
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
  const [fileProgress, setFileProgress] = useState<AppBuilderFileProgress[]>([]);

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
    setFileProgress([]);
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
    setFileProgress([]);
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
        } else if (event.type === "file-progress") {
          setFileProgress((current) => upsertFileProgress(current, event.progress));
        } else if (event.type === "draft") {
          setFileProgress([]);
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
          kind: "component",
          label: `${baseTarget.label} -> ${selectedElement.selector}`,
          selector: selectedElement.selector,
        }
      : baseTarget;
    const composedPrompt = selectedElement
      ? `On the element \`${selectedElement.selector}\`${selectedElement.label ? ` ("${selectedElement.label}")` : ""}: ${effectivePrompt}`
      : effectivePrompt;
    lastPromptRef.current = { kind: "iterate", text: effectivePrompt };
    setWorking(true);
    setError(null);
    setMode("iterating");
    setFileProgress([]);
    setTab("files");
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
          } else if (event.type === "file-progress") {
            setFileProgress((current) => upsertFileProgress(current, event.progress));
          } else if (event.type === "diff") {
            setFileProgress([]);
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
      setFileProgress([]);
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
      setFileProgress([]);
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
      setFileProgress([]);
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

  return {
    mode,
    builderKind,
    setBuilderKind,
    agentAutoGenerate,
    prompt,
    setPrompt,
    iterPrompt,
    setIterPrompt,
    setIterTargetId,
    error,
    working,
    tab,
    setTab,
    checkpoints,
    publishState,
    fileProgress,
    state,
    messages,
    composerPreset,
    setComposerPreset,
    providerStatus,
    selectedElement,
    setSelectedElement,
    threadRef,
    iterationTargetOptions,
    selectedIterationTarget,
    selectedTargetKind,
    openAgentBuilder,
    submitInitialPrompt,
    generate,
    approve,
    iterate,
    applyIteration,
    rollback,
    branch,
    publish,
    rollbackPublish,
    draft,
  };
}
