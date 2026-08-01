import { triggerLabel } from "@/lib/agent-runtime";
import { I } from "../../icons";
import {
  formatApprovalExpiry,
  riskForApprovalTool,
  riskPillClass,
  type PendingRunApproval,
} from "./helpers";

export function ApprovalPanel({
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
