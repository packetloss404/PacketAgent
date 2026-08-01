import { agentEditorPath } from "./builder-agent-utils";
import { I } from "../icons";
import {
  type AgentBuilderApproveResult,
  type AgentRecord,
  type BuilderModelPresetId,
} from "@/lib/types";
import { AgentConfiguration, SampleInputs } from "./builder-agent/configuration";
import { DraftPlan, DraftSummary, ReadinessGrid } from "./builder-agent/draft-review";
import { ApproveCard, FirstRunPanel } from "./builder-agent/first-run";
import { useAgentBuilderController } from "./builder-agent/use-agent-builder-controller";

export interface AgentBuilderPanelProps {
  initialPrompt?: string;
  embedded?: boolean;
  autoGenerate?: boolean;
  preset?: BuilderModelPresetId;
  onAgentSaved?: (agent: AgentRecord, result: AgentBuilderApproveResult) => void;
}

export function AgentBuilderPanel({
  initialPrompt = "",
  embedded = false,
  autoGenerate = false,
  preset = "smart",
  onAgentSaved,
}: AgentBuilderPanelProps) {
  const {
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
  } = useAgentBuilderController({ initialPrompt, autoGenerate, preset, onAgentSaved });

  return (
    <div
      style={{
        minHeight: embedded ? undefined : "calc(100vh - 52px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {!embedded && (
        <div
          style={{
            padding: "22px 28px",
            borderBottom: "1px solid var(--line)",
            background: "var(--bg-elev)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: "1px solid var(--line)",
                background: "var(--panel)",
                display: "grid",
                placeItems: "center",
                color: "var(--green)",
              }}
            >
              <I.bot size={16} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="kicker">Agent builder</div>
              <h1 className="h1" style={{ fontSize: 24, marginTop: 3 }}>
                Describe the agent you want to build.
              </h1>
            </div>
            {savedAgent && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginLeft: "auto" }}
                onClick={() => navigate(agentEditorPath(savedAgent.id))}
              >
                <I.edit size={13} /> Open editor
              </button>
            )}
          </div>
        </div>
      )}

      <div
        style={{
          padding: embedded ? "14px 18px 16px" : "22px 28px",
          borderTop: embedded ? "1px solid var(--line)" : undefined,
          display: "grid",
          gridTemplateColumns: draft
            ? "repeat(auto-fit, minmax(min(100%, 340px), 1fr))"
            : "minmax(0, 760px)",
          gap: 18,
          alignItems: "start",
          justifyContent: draft ? "stretch" : "center",
        }}
      >
        <section className="card" style={{ padding: 14 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Prompt
          </div>
          <textarea
            className="field"
            style={{ minHeight: 118, background: "transparent", resize: "vertical" }}
            placeholder="e.g. Build an agent that reviews new support incidents, classifies severity, creates blockers for critical issues, and posts a concise handoff."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={working}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--line)",
            }}
          >
            <span className="mono muted" style={{ fontSize: 11 }}>
              {prompt.length} chars
            </span>
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginLeft: "auto" }}
              disabled={!prompt.trim() || working}
              onClick={() => {
                void generateDraft();
              }}
            >
              {mode === "drafting" ? (
                <span className="spin">
                  <I.refresh size={13} />
                </span>
              ) : (
                <I.sparkle size={13} />
              )}
              {draft ? " Regenerate draft" : " Generate draft"}
            </button>
          </div>
          {error && <ErrorNotice error={error} />}
        </section>

        {draft && (
          <section style={{ display: "grid", gap: 14 }}>
            <DraftSummary draft={draft} savedAgent={savedAgent} />
            <ReadinessGrid draft={draft} />
            <DraftPlan draft={draft} />
            <AgentConfiguration
              draft={draft}
              editable={!savedAgent}
              onMemoryChange={updateMemory}
              onExpectedOutputChange={updateExpectedOutput}
            />
            <SampleInputs
              draft={draft}
              editable={!savedAgent}
              sampleInputs={sampleInputs}
              issues={sampleInputIssues}
              onUpdate={updateSample}
            />
            <ApproveCard
              draft={draft}
              working={working}
              savedAgent={savedAgent}
              runPreview={runPreview}
              sampleInputIssues={sampleInputIssues}
              onRunPreviewChange={setRunPreview}
              onApprove={() => {
                void approveDraft();
              }}
              onOpenAgent={() => savedAgent && navigate(agentEditorPath(savedAgent.id))}
            />
            {(firstRun || firstRunApproval || savedAgent) && (
              <FirstRunPanel
                run={firstRun}
                agent={savedAgent}
                approval={firstRunApproval}
                running={firstRunRunning}
                onLaunch={() => {
                  void launchFirstRun();
                }}
                onCancel={() => setFirstRunApproval(null)}
              />
            )}
          </section>
        )}
      </div>

      {working && (
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
          {mode === "drafting" ? "Generating agent draft..." : "Saving agent..."}
        </div>
      )}
    </div>
  );
}

function ErrorNotice({ error }: { error: string }) {
  return (
    <div
      className="card"
      style={{
        padding: "10px 12px",
        marginTop: 12,
        borderColor: "rgba(242,107,92,0.3)",
        color: "var(--danger)",
      }}
    >
      <span className="mono" style={{ fontSize: 11.5 }}>
        ERR - {error}
      </span>
    </div>
  );
}
