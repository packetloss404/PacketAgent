import { useState } from "react";
import { formatDuration } from "@/lib/agent-runtime";
import type {
  AgentRunRecord,
  AgentRunStep,
  AgentRunStepStatus,
  AgentRunToolCall,
} from "@/lib/types";
import { safeStringify } from "./helpers";

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
  const statusPill = (status: AgentRunStepStatus) =>
    status === "success" ? "good" : status === "failed" ? "danger" : "muted";
  const statusLabel = (status: AgentRunStepStatus) =>
    status === "success" ? "OK" : status === "failed" ? "FAIL" : "SKIP";
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

export function FirstRunEvaluationPanel({ run }: { run: AgentRunRecord }) {
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
  const statusPill = (status: AgentRunToolCall["status"]) =>
    status === "ok" ? "good" : status === "timeout" ? "warn" : "danger";
  const statusLabel = (status: AgentRunToolCall["status"]) =>
    status === "ok" ? "OK" : status === "timeout" ? "T/O" : "ERR";
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
