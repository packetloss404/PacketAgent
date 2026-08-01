import { I } from "../../icons";
import {
  type AgentBuilderDraft,
  type AgentRecord,
  type AgentRunRecord,
  type ToolCapabilityApprovalRequest,
} from "@/lib/types";
import {
  type AgentBuilderSampleInputIssue,
  firstRunEvaluationTone,
  formatSampleValue,
  runStatusTone,
  safeJson,
} from "../builder-agent-utils";

export function ApproveCard({
  draft,
  working,
  savedAgent,
  runPreview,
  sampleInputIssues,
  onRunPreviewChange,
  onApprove,
  onOpenAgent,
}: {
  draft: AgentBuilderDraft;
  working: boolean;
  savedAgent: AgentRecord | null;
  runPreview: boolean;
  sampleInputIssues: AgentBuilderSampleInputIssue[];
  onRunPreviewChange: (next: boolean) => void;
  onApprove: () => void;
  onOpenAgent: () => void;
}) {
  const setupCanRun = draft.readiness.firstRun.canRun;
  const canRunPreview = setupCanRun && sampleInputIssues.length === 0;
  const runBlocker = setupCanRun
    ? sampleInputIssues[0]?.message
    : draft.readiness.firstRun.blockers.join(", ") || "not available";
  return (
    <div
      className="card"
      style={{ padding: 16, borderColor: savedAgent ? "var(--green-deep)" : "var(--line)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div>
          <div
            className="kicker"
            style={{ color: savedAgent ? "var(--green)" : "var(--silver-300)" }}
          >
            {savedAgent ? "Saved" : "Ready to approve"}
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            {savedAgent
              ? "The draft is now a saved agent. Open the editor to adjust tools, schedule, webhook, or playbook details."
              : "Approving saves the generated agent as active. The optional first run uses the generated sample inputs above."}
          </p>
        </div>
        {savedAgent ? (
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginLeft: "auto", flexShrink: 0 }}
            onClick={onOpenAgent}
          >
            <I.edit size={13} /> Open saved agent
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginLeft: "auto", flexShrink: 0 }}
            disabled={working}
            onClick={onApprove}
          >
            {working ? (
              <span className="spin">
                <I.refresh size={13} />
              </span>
            ) : (
              <I.check size={13} />
            )}
            {runPreview && canRunPreview ? " Approve, save & run" : " Approve & save"}
          </button>
        )}
      </div>
      {!savedAgent && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--line)",
            color: canRunPreview ? "var(--silver-200)" : "var(--silver-400)",
            fontSize: 12.5,
          }}
        >
          <input
            type="checkbox"
            checked={runPreview && canRunPreview}
            disabled={!canRunPreview || working}
            onChange={(e) => onRunPreviewChange(e.target.checked)}
            style={{ accentColor: "var(--green)" }}
          />
          Run once after save
          {!canRunPreview && (
            <span className="mono muted" style={{ fontSize: 10.5 }}>
              ({runBlocker})
            </span>
          )}
        </label>
      )}
    </div>
  );
}

export function FirstRunPanel({
  run,
  agent,
  approval,
  running,
  onLaunch,
  onCancel,
}: {
  run: AgentRunRecord | null;
  agent: AgentRecord | null;
  approval: ToolCapabilityApprovalRequest | null;
  running: boolean;
  onLaunch: () => void;
  onCancel: () => void;
}) {
  if (approval) {
    return (
      <div className="card" style={{ padding: 16, borderColor: "rgba(240,180,41,0.35)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.shield size={14} style={{ color: "var(--warn)" }} />
          <div className="kicker">First-run tool approval</div>
          <span className="pill warn" style={{ marginLeft: "auto" }}>
            <span className="dot"></span>
            approval required
          </span>
        </div>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
          {approval.summary}
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {approval.tools.map((tool) => (
            <span key={tool.name} className={`pill ${tool.risk === "high" ? "danger" : "warn"}`}>
              {tool.name} · {tool.side}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-primary" disabled={running} onClick={onLaunch}>
            {running ? <I.refresh size={13} /> : <I.play size={13} />}
            {running ? " Running evaluation" : " Approve & run evaluation"}
          </button>
          <button type="button" className="btn" disabled={running} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="card" style={{ padding: 16 }}>
        <div className="kicker">First run</div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          {agent
            ? "No preview run was requested. The saved agent can be run from its editor."
            : "Save the draft to run a preview."}
        </p>
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <I.activity size={14} style={{ color: "var(--green)" }} />
        <div className="kicker">First run</div>
        <span className={`pill ${runStatusTone(run)}`} style={{ marginLeft: "auto" }}>
          <span className="dot"></span>
          {run.status}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
          gap: 12,
        }}
      >
        <div>
          <div className="label">Run</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--silver-200)" }}>
            {run.title || run.id}
          </div>
        </div>
        <div>
          <div className="label">Inputs</div>
          <div className="mono muted" style={{ fontSize: 11 }}>
            {Object.entries(run.inputs ?? {})
              .map(([key, value]) => `${key}: ${formatSampleValue(value)}`)
              .join(" - ") || "none"}
          </div>
        </div>
      </div>
      {run.output && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div className="kicker" style={{ marginBottom: 6 }}>
            Output
          </div>
          <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--silver-200)", margin: 0 }}>
            {run.output}
          </p>
        </div>
      )}
      {run.error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            border: "1px solid rgba(242,107,92,0.28)",
            borderRadius: 6,
            color: "var(--danger)",
            fontSize: 12,
          }}
        >
          {run.error}
        </div>
      )}
      {run.evaluation && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div className="kicker">Evaluation</div>
            <span className={`pill ${firstRunEvaluationTone(run)}`} style={{ marginLeft: "auto" }}>
              <span className="dot"></span>
              {run.evaluation.status}
            </span>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {run.evaluation.checks.map((check) => (
              <div
                key={check.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(120px, 0.35fr) auto minmax(0, 1fr)",
                  gap: 8,
                  alignItems: "baseline",
                }}
              >
                <span style={{ fontSize: 12, color: "var(--silver-200)" }}>{check.label}</span>
                <span className={`pill ${check.status === "passed" ? "good" : "danger"}`}>
                  {check.status}
                </span>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {check.note}
                </span>
              </div>
            ))}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
              gap: 10,
              marginTop: 10,
            }}
          >
            <div>
              <div className="label">Expected output</div>
              <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.45, margin: 0 }}>
                {run.evaluation.expected.output || "Non-empty output."}
              </p>
            </div>
            <div>
              <div className="label">Actual output</div>
              <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.45, margin: 0 }}>
                {run.evaluation.actual.output || "No output captured."}
              </p>
            </div>
          </div>
          <div className="mono muted" style={{ fontSize: 10.5, marginTop: 8 }}>
            {run.evaluation.notes.join(" ")}
          </div>
        </div>
      )}
      {run.transcript && run.transcript.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div className="kicker" style={{ marginBottom: 6 }}>
            Transcript
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {run.transcript.map((step, index) => (
              <div
                key={step.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "32px 1fr auto",
                  gap: 8,
                  alignItems: "baseline",
                }}
              >
                <span className="mono muted" style={{ fontSize: 11 }}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span style={{ fontSize: 12, color: "var(--silver-200)" }}>{step.title}</span>
                <span
                  className={`pill ${step.status === "success" ? "good" : step.status === "failed" ? "danger" : "muted"}`}
                >
                  {step.status}
                </span>
                {step.output && (
                  <span className="muted" style={{ gridColumn: "2 / 4", fontSize: 11.5 }}>
                    {step.output}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {run.toolCalls && run.toolCalls.length > 0 && (
        <details style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <summary className="kicker" style={{ cursor: "pointer" }}>
            Actions taken - {run.toolCalls.length}
          </summary>
          <pre
            className="mono"
            style={{
              marginTop: 8,
              padding: 10,
              fontSize: 10.5,
              lineHeight: 1.5,
              background: "var(--ink)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              color: "var(--silver-200)",
              overflow: "auto",
            }}
          >
            {safeJson(run.toolCalls)}
          </pre>
        </details>
      )}
    </div>
  );
}
