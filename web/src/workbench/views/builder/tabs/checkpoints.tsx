import { I } from "../../../icons";
import type { AppBuilderCheckpointSummary } from "@/lib/types";
import { formatRelative } from "../helpers";

export function CheckpointsTab({
  checkpoints,
  currentId,
  onRollback,
  onBranch,
  working,
}: {
  checkpoints: AppBuilderCheckpointSummary[];
  currentId: string | null;
  onRollback: (id: string) => void;
  onBranch: (id: string) => void;
  working: boolean;
}) {
  return (
    <div style={{ padding: 22, maxWidth: 880 }}>
      <div className="kicker">Checkpoints · {checkpoints.length} total</div>
      <h2 className="h2" style={{ marginBottom: 14 }}>
        History
      </h2>
      {checkpoints.length === 0 && (
        <div className="card muted" style={{ padding: 22, textAlign: "center" }}>
          No checkpoints yet. Approving the draft creates the first one.
        </div>
      )}
      <div className="card" style={{ overflow: "hidden" }}>
        {checkpoints.map((c, i) => {
          const isCurrent = c.id === currentId;
          return (
            <div
              key={c.id}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto auto",
                alignItems: "center",
                gap: 12,
                padding: "13px 16px",
                borderTop: i === 0 ? "none" : "1px solid var(--line)",
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: isCurrent ? "var(--green)" : "var(--silver-500)",
                  boxShadow: isCurrent ? "0 0 8px var(--green)" : "none",
                }}
              ></div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{c.label}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  Save #{i + 1} · {formatRelative(c.createdAt)} · {c.source}
                </div>
                <details style={{ marginTop: 4 }}>
                  <summary className="muted" style={{ fontSize: 11, cursor: "pointer" }}>
                    Details
                  </summary>
                  <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                    {c.id}
                    {c.previousCheckpointId ? ` · ← ${c.previousCheckpointId}` : ""}
                  </div>
                </details>
              </div>
              <span className="mono muted" style={{ fontSize: 11 }}>
                {new Date(c.createdAt).toLocaleString()}
              </span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {isCurrent && (
                  <span className="pill good">
                    <span className="dot"></span>current
                  </span>
                )}
                {!isCurrent && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={working}
                    onClick={() => onRollback(c.id)}
                    title="Restore this checkpoint as the current state"
                  >
                    <I.history size={11} /> Restore
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={working}
                  onClick={() => onBranch(c.id)}
                  title="Fork into a new app starting from this checkpoint"
                >
                  <I.branch size={11} /> Branch
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
