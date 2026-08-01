import { triggerLabel } from "@/lib/agent-runtime";
import type { AgentInputField, AgentPlaybookStep, AgentRecord, AgentRunRecord } from "@/lib/types";
import { I } from "../../icons";
import { ApprovalPanel } from "./approval-panel";
import { RunInputControl } from "./contract-editors";
import type { PendingRunApproval } from "./helpers";
import { PlaybookReplacementReview } from "./playbook";
import { FirstRunEvaluationPanel, RunTranscript, ToolCallTimeline } from "./run-presenters";

export interface AgentRunSidebarProps {
  isNew: boolean;
  agent: AgentRecord | null;
  inputSchema: AgentInputField[];
  runInputs: Record<string, string>;
  canRunAgent: boolean;
  canManageAgent: boolean;
  running: boolean;
  saving: boolean;
  firstRunEvaluationPending: boolean;
  pendingApproval: PendingRunApproval | null;
  runs: AgentRunRecord[];
  expandedRun: string | null;
  playbookReviewRunId: string | null;
  recordingRunId: string | null;
  playbook: AgentPlaybookStep[];
  updateRunInputValue: (key: string, next: string) => void;
  runNow: () => void;
  launchPendingApproval: () => void;
  editPendingTools: () => void;
  cancelPendingApproval: () => void;
  setExpandedRun: (runId: string | null) => void;
  setPlaybookReviewRunId: (runId: string | null) => void;
  recordAsPlaybook: (runId: string) => void;
}

export function AgentRunSidebar({
  isNew,
  agent,
  inputSchema,
  runInputs,
  canRunAgent,
  canManageAgent,
  running,
  saving,
  firstRunEvaluationPending,
  pendingApproval,
  runs,
  expandedRun,
  playbookReviewRunId,
  recordingRunId,
  playbook,
  updateRunInputValue,
  runNow,
  launchPendingApproval,
  editPendingTools,
  cancelPendingApproval,
  setExpandedRun,
  setPlaybookReviewRunId,
  recordAsPlaybook,
}: AgentRunSidebarProps) {
  return (
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
                      if (expanded && playbookReviewRunId === r.id) setPlaybookReviewRunId(null);
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
                        {new Date(r.createdAt).toLocaleString()} · {triggerLabel(r.triggerKind)}
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
                              {recordingRunId === r.id ? " Replacing..." : " Review replacement"}
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
  );
}
