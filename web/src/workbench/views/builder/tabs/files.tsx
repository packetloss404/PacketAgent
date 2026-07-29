import { useMemo, useState } from "react";
import type {
  AppBuilderDraft,
  AppBuilderIterationDiffFile,
  AppBuilderIterationResult,
  AppBuilderSourceFileSummary,
  AppBuilderWorkspaceSummary,
} from "@/lib/types";

export function FilesTab({
  draft,
  iteration,
  sourceFiles,
  workspace,
}: {
  draft: AppBuilderDraft;
  iteration: AppBuilderIterationResult | null;
  sourceFiles: AppBuilderSourceFileSummary[];
  workspace: AppBuilderWorkspaceSummary | null;
}) {
  const files = useMemo<AppBuilderIterationDiffFile[]>(() => iteration?.files ?? [], [iteration]);
  const [selected, setSelected] = useState<number>(0);
  if (files.length === 0) {
    return (
      <div style={{ padding: 22 }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Generated workspace
          </div>
          <h2 className="h2" style={{ marginBottom: 6 }}>
            Saved source bundle
          </h2>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
            No pending diff. The current checkpoint has {sourceFiles.length || "no"} generated
            source file{sourceFiles.length === 1 ? "" : "s"}.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "150px 1fr",
              gap: 8,
              fontSize: 12.5,
              marginBottom: 14,
            }}
          >
            <span className="muted">Workspace</span>
            <span className="mono" style={{ color: "var(--silver-200)", overflowWrap: "anywhere" }}>
              {workspace?.checkpointPath ?? "not written yet"}
            </span>
            <span className="muted">Manifest</span>
            <span className="mono" style={{ color: "var(--silver-200)", overflowWrap: "anywhere" }}>
              {workspace?.manifest.path ?? "pending"}
            </span>
            <span className="muted">App skeleton</span>
            <span className="mono" style={{ color: "var(--silver-200)" }}>
              {draft.app.pages.length} pages · {draft.app.apiRoutes.length} routes
            </span>
          </div>
          {sourceFiles.length > 0 && (
            <div className="card" style={{ overflow: "hidden" }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Path</th>
                    <th>Role</th>
                    <th>Size</th>
                    <th>SHA</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceFiles.slice(0, 14).map((file) => (
                    <tr key={file.path}>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {file.path}
                      </td>
                      <td>
                        <span className="pill muted">{file.role}</span>
                      </td>
                      <td className="mono muted" style={{ fontSize: 11.5 }}>
                        {file.size}
                      </td>
                      <td className="mono muted" style={{ fontSize: 11.5 }}>
                        {file.sha256.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }
  const current = files[selected]!;
  return (
    <div
      style={{
        padding: 18,
        display: "grid",
        gridTemplateColumns: "320px 1fr",
        gap: 14,
        height: "100%",
      }}
    >
      <div className="card" style={{ overflow: "auto" }}>
        {files.map((f, i) => (
          <div
            key={i}
            onClick={() => setSelected(i)}
            style={{
              padding: "9px 14px",
              borderBottom: i === files.length - 1 ? "none" : "1px solid var(--line)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              background: selected === i ? "var(--bg-elev)" : "transparent",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 11,
                width: 14,
                color:
                  f.changeType === "added"
                    ? "var(--green)"
                    : f.changeType === "modified"
                      ? "var(--warn)"
                      : "var(--danger)",
              }}
            >
              {f.changeType === "added"
                ? "A"
                : f.changeType === "modified"
                  ? "M"
                  : f.changeType === "deleted"
                    ? "D"
                    : "R"}
            </span>
            <span
              className="mono"
              style={{
                fontSize: 11.5,
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--silver-200)",
              }}
            >
              {f.path}
            </span>
          </div>
        ))}
      </div>
      <div
        className="card"
        style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
          <div className="mono" style={{ fontSize: 12, color: "var(--silver-100)" }}>
            {current.path}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
            {current.summary}
          </div>
        </div>
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: 14,
            fontSize: 11.5,
            lineHeight: 1.6,
            background: "var(--ink)",
            color: "var(--silver-200)",
            overflow: "auto",
            flex: 1,
            whiteSpace: "pre",
          }}
        >
          {current.diff}
        </pre>
      </div>
    </div>
  );
}
