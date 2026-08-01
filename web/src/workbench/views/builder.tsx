import { AgentBuilderPanel } from "./builder-agent";
import {
  BUILDER_STARTER_PROMPTS,
  builderPrimaryActionCopy,
  resolveBuilderStartKind,
} from "./builder-start";
import { BuilderTour } from "./builder-tour";
import {
  buildFixErrorsPrompt,
  describeMessageForContext,
  nextSmarterPreset,
} from "./builder/helpers";
import { CheckpointsTab } from "./builder/tabs/checkpoints";
import { FileGenerationProgress, FilesTab } from "./builder/tabs/files";
import { I, type IconKey } from "../icons";
import { LogsTab, SmokeTab } from "./builder/tabs/smoke-logs";
import { PRESET_OPTIONS } from "./builder/constants";
import { PreviewTab } from "./builder/tabs/preview";
import { ProviderBanner } from "./builder-provider-banner";
import { PublishTab } from "./builder/tabs/publish";
import { resetBuilderTour } from "./builder-tour-state";
import { SandboxBuilderTab } from "./builder/tabs/sandbox";
import { ThreadMessage } from "./builder/thread";
import { useBuilderController } from "./builder/use-builder-controller";

export function BuilderView() {
  const {
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
  } = useBuilderController();

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
                type="button"
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
        <AgentBuilderPanel
          initialPrompt={prompt}
          embedded
          autoGenerate={agentAutoGenerate}
          preset={composerPreset}
        />
      )}

      {builderKind === "app" && mode === "drafting" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            height: "calc(100vh - 40px)",
            minHeight: 0,
          }}
        >
          <div className="tabbar">
            <div className="tab active">
              <I.code size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              Source
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            <FileGenerationProgress progress={fileProgress} />
          </div>
        </div>
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
                      type="button"
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
                      type="button"
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
                        type="button"
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
                      type="button"
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
                      type="button"
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
                        type="button"
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
                    checkpointId={state.checkpointId}
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
                    appId={state.appId}
                    checkpointId={state.checkpointId}
                    progress={fileProgress}
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
