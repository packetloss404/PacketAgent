import { I } from "../../../icons";
import type { AppBuilderPublishState } from "@/lib/types";
import { formatRelative, publishPrimaryActionLabel, publishReadinessHeading } from "../helpers";
import type { PublishRollbackAction } from "../types";

export function PublishTab({
  state,
  canPublish,
  onPublish,
  onRollback,
  working,
}: {
  state: AppBuilderPublishState | null;
  canPublish: boolean;
  onPublish: () => void;
  onRollback: (action: PublishRollbackAction) => void;
  working: boolean;
}) {
  if (!canPublish) {
    return (
      <div style={{ padding: 22 }}>
        <div className="card muted" style={{ padding: 22, textAlign: "center" }}>
          Approve the draft first — publish handoff requires a saved preview and checkpoint.
        </div>
      </div>
    );
  }
  if (!state) {
    return (
      <div style={{ padding: 22 }} className="muted">
        Loading publish state…
      </div>
    );
  }
  const readiness = state.readiness;
  const handoffUrl = state.publishedUrl ?? readiness.urlHandoff.privateUrl;
  const artifactIntegrity = state.validation?.artifactPresence?.integrity;
  return (
    <div style={{ padding: 22, maxWidth: 900 }}>
      <div className="kicker">Publish · {state.status}</div>
      <div
        style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 4, marginBottom: 14 }}
      >
        <h2 className="h2">{publishReadinessHeading(state)}</h2>
        {handoffUrl && (
          <a
            href={handoffUrl}
            target="_blank"
            rel="noreferrer"
            className="mono"
            style={{ fontSize: 12, color: "var(--green)", textDecoration: "underline" }}
          >
            {handoffUrl}
          </a>
        )}
      </div>
      <p
        className="muted"
        style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 720, marginBottom: 14 }}
      >
        This panel records the local publish package, validation checks, and URL handoff. It does
        not start a separate cloud runtime.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!state.canPublish || working}
          onClick={onPublish}
        >
          {working ? (
            <span className="spin">
              <I.refresh size={13} />
            </span>
          ) : (
            <I.rocket size={13} />
          )}
          {publishPrimaryActionLabel(working)}
        </button>
        {state.rollbackActions.map((action) => (
          <button
            type="button"
            key={action.id}
            className="btn btn-sm"
            disabled={action.disabled || working || !action.publishId}
            onClick={() => onRollback(action)}
          >
            <I.history size={11} /> {action.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div className="kicker" style={{ marginBottom: 8 }}>
          Local package
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 8, fontSize: 12.5 }}>
          <span className="muted">Runtime</span>
          <span className="mono" style={{ color: "var(--silver-200)" }}>
            {readiness.packaging.runtime}
          </span>
          <span className="muted">Bundle path</span>
          <span className="mono" style={{ color: "var(--silver-200)" }}>
            {readiness.localPublishPath}
          </span>
          <span className="muted">Artifacts</span>
          <span className="mono" style={{ color: "var(--silver-200)" }}>
            {readiness.packaging.artifactPaths.join(", ")}
          </span>
        </div>
      </div>

      {artifactIntegrity && (
        <div className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 8,
            }}
          >
            <div className="kicker">Artifact integrity</div>
            <span className={`pill ${artifactIntegrity.status === "verified" ? "good" : "danger"}`}>
              {artifactIntegrity.status}
            </span>
          </div>
          <div className="mono muted" style={{ fontSize: 11.5 }}>
            {artifactIntegrity.checkedFiles} files · {artifactIntegrity.checkedBytes} bytes ·
            signature {artifactIntegrity.signatureStatus}
          </div>
          {artifactIntegrity.issues[0] && (
            <div style={{ color: "var(--danger)", fontSize: 11.5, marginTop: 8 }} role="status">
              {artifactIntegrity.issues[0].path}: {artifactIntegrity.issues[0].message}
            </div>
          )}
        </div>
      )}

      {state.nextActions.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div className="kicker" style={{ marginBottom: 6 }}>
            Next actions
          </div>
          {state.nextActions.map((a, i) => (
            <div key={i} style={{ fontSize: 12.5, color: "var(--silver-300)", padding: "2px 0" }}>
              · {a}
            </div>
          ))}
        </div>
      )}

      {state.history.length > 0 && (
        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>
            History · {state.history.length}
          </div>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Publish</th>
                  <th>Status</th>
                  <th>Actor</th>
                  <th>Recorded</th>
                  <th>Handoff URL</th>
                </tr>
              </thead>
              <tbody>
                {state.history.map((h, i) => (
                  <tr key={h.id}>
                    <td style={{ fontSize: 11.5 }}>
                      <details>
                        <summary style={{ cursor: "pointer" }}>
                          Publish #{i + 1} · {h.publishedAt ? formatRelative(h.publishedAt) : "—"}
                        </summary>
                        <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                          {h.id}
                        </div>
                      </details>
                    </td>
                    <td>
                      <span
                        className={`pill ${h.status === "published" ? "good" : h.status === "rolled_back" ? "warn" : "muted"}`}
                      >
                        <span className="dot"></span>
                        {h.status}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {h.actor ?? "—"}
                    </td>
                    <td className="mono muted" style={{ fontSize: 11.5 }}>
                      {h.publishedAt ? new Date(h.publishedAt).toLocaleString() : "—"}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {h.url ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
