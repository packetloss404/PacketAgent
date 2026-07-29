import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type {
  AppBuilderDraft,
  AppBuilderFileProgress,
  AppBuilderIterationDiffFile,
  AppBuilderIterationFileReview,
  AppBuilderIterationResult,
  AppBuilderPackageInstallPlan,
  AppBuilderSourceFileSummary,
  AppBuilderWorkspaceSummary,
} from "@/lib/types";

export function FileGenerationProgress({ progress }: { progress: AppBuilderFileProgress[] }) {
  const filePaths = [...new Set(progress.flatMap((entry) => (entry.path ? [entry.path] : [])))];
  const latestAttempt = progress.reduce((latest, entry) => Math.max(latest, entry.attempt), 0);
  const current = progress.filter((entry) => entry.attempt === latestAttempt);
  const phaseState = (path: string, phase: AppBuilderFileProgress["phase"]) =>
    current.find((entry) => entry.path === path && entry.phase === phase);
  const completed = current.filter(
    (entry) => entry.phase === "validate" && entry.status === "completed",
  ).length;
  const failed = current.filter(
    (entry) => entry.phase === "validate" && entry.status === "failed",
  ).length;
  const skipped = current.filter(
    (entry) => entry.phase === "validate" && entry.status === "skipped",
  ).length;

  return (
    <div style={{ padding: 22, height: "100%", overflow: "auto" }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="kicker" style={{ marginBottom: 8 }}>
          Source progress
        </div>
        <h2 className="h2" style={{ marginBottom: 6 }}>
          {latestAttempt > 0 ? `Repair pass ${latestAttempt}` : "Building the file tree"}
        </h2>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
          Plan, write, and batch-validation state streams from the active generation.
          {completed > 0 || failed > 0 || skipped > 0
            ? ` ${completed} validated${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}.`
            : ""}
        </p>
        {filePaths.length === 0 ? (
          <div className="muted" role="status" aria-live="polite">
            Planning the source tree…
          </div>
        ) : (
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Plan</th>
                  <th>Write</th>
                  <th>Validate</th>
                </tr>
              </thead>
              <tbody>
                {filePaths.map((path) => (
                  <tr key={path}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {path}
                    </td>
                    {(["plan", "write", "validate"] as const).map((phase) => {
                      const state = phaseState(path, phase);
                      return (
                        <td key={phase}>
                          <span
                            className={`pill ${
                              state?.status === "completed"
                                ? "good"
                                : state?.status === "failed"
                                  ? "danger"
                                  : state?.status === "skipped"
                                    ? "warn"
                                    : "muted"
                            }`}
                          >
                            {state?.status ?? "queued"}
                            {state?.errorCount ? ` · ${state.errorCount}` : ""}
                          </span>
                        </td>
                      );
                    })}
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

export function FilesTab({
  draft,
  iteration,
  sourceFiles,
  workspace,
  appId,
  checkpointId,
  progress = [],
}: {
  draft: AppBuilderDraft;
  iteration: AppBuilderIterationResult | null;
  sourceFiles: AppBuilderSourceFileSummary[];
  workspace: AppBuilderWorkspaceSummary | null;
  appId: string | null;
  checkpointId: string | null;
  progress?: AppBuilderFileProgress[];
}) {
  const [reviewFilter, setReviewFilter] = useState<"all" | "changed" | "unchanged">("all");
  const files = useMemo<Array<AppBuilderIterationDiffFile | AppBuilderIterationFileReview>>(() => {
    const review = iteration?.fileReview;
    const candidates = review && review.length > 0 ? review : (iteration?.files ?? []);
    if (reviewFilter === "unchanged") {
      return candidates.filter((file) => file.changeType === "unchanged");
    }
    if (reviewFilter === "changed") {
      return candidates.filter((file) => file.changeType !== "unchanged");
    }
    return candidates;
  }, [iteration, reviewFilter]);
  const [selected, setSelected] = useState<number>(0);
  if (progress.length > 0) {
    return <FileGenerationProgress progress={progress} />;
  }
  if (files.length === 0 && !iteration?.fileReview) {
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
          <WorkspaceExportPanel appId={appId} checkpointId={checkpointId} />
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
  const selectedIndex = Math.min(selected, Math.max(0, files.length - 1));
  const current = files[selectedIndex];
  const reviewCounts = iteration?.fileReview
    ? {
        all: iteration.fileReview.length,
        changed: iteration.fileReview.filter((file) => file.changeType !== "unchanged").length,
        unchanged: iteration.fileReview.filter((file) => file.changeType === "unchanged").length,
      }
    : null;
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
        <WorkspaceExportPanel appId={appId} checkpointId={checkpointId} compact />
        {reviewCounts && (
          <div
            style={{
              display: "flex",
              gap: 6,
              padding: "10px 12px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            {(["all", "changed", "unchanged"] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                className="btn btn-sm"
                aria-pressed={reviewFilter === filter}
                onClick={() => {
                  setReviewFilter(filter);
                  setSelected(0);
                }}
              >
                {filter} · {reviewCounts[filter]}
              </button>
            ))}
          </div>
        )}
        {files.length === 0 && (
          <div className="muted" style={{ padding: 14 }}>
            No files match this review filter.
          </div>
        )}
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
              background: selectedIndex === i ? "var(--bg-elev)" : "transparent",
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
                      : f.changeType === "unchanged"
                        ? "var(--silver-500)"
                        : "var(--danger)",
              }}
            >
              {f.changeType === "added"
                ? "A"
                : f.changeType === "modified"
                  ? "M"
                  : f.changeType === "deleted"
                    ? "D"
                    : f.changeType === "unchanged"
                      ? "U"
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
      {current ? (
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
      ) : (
        <div className="card muted" style={{ padding: 18 }}>
          Select a review filter with matching files.
        </div>
      )}
    </div>
  );
}

function WorkspaceExportPanel({
  appId,
  checkpointId,
  compact = false,
}: {
  appId: string | null;
  checkpointId: string | null;
  compact?: boolean;
}) {
  const planKey = `${appId ?? ""}:${checkpointId ?? ""}`;
  const [planState, setPlanState] = useState<{
    key: string;
    plan: AppBuilderPackageInstallPlan | null;
    error: string | null;
  }>({ key: "", plan: null, error: null });
  const [working, setWorking] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const plan = planState.key === planKey ? planState.plan : null;
  const planError = planState.key === planKey ? planState.error : null;

  useEffect(() => {
    let active = true;
    if (!appId) return () => undefined;
    void api
      .getGeneratedAppPackagePlan({
        appId,
        ...(checkpointId ? { checkpointId } : {}),
      })
      .then((payload) => {
        if (active) setPlanState({ key: planKey, plan: payload.plan, error: null });
      })
      .catch((cause: unknown) => {
        if (active) {
          setPlanState({
            key: planKey,
            plan: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [appId, checkpointId, planKey]);

  const download = async () => {
    if (!appId || working) return;
    setWorking(true);
    setExportError(null);
    try {
      const exported = await api.downloadGeneratedAppExport({
        appId,
        ...(checkpointId ? { checkpointId } : {}),
      });
      const url = URL.createObjectURL(exported.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      style={{
        padding: compact ? "10px 12px" : 14,
        marginBottom: compact ? 0 : 14,
        borderBottom: compact ? "1px solid var(--line)" : undefined,
        border: compact ? undefined : "1px solid var(--line)",
        borderRadius: compact ? undefined : 8,
        background: compact ? undefined : "var(--bg-elev)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: "var(--silver-100)" }}>Git-ready ZIP export</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            Package plan: {plan?.status ?? (appId ? "loading" : "save the app first")}
            {plan?.packages.length ? ` · ${plan.packages.length} packages reviewed` : ""}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!appId || working}
          onClick={() => {
            void download();
          }}
        >
          {working ? "Exporting…" : "Download ZIP"}
        </button>
      </div>
      {plan?.status === "blocked" || plan?.status === "invalid" ? (
        <p style={{ color: "var(--warn)", fontSize: 11, marginTop: 6 }}>
          The source is exportable, but package installation is blocked. Review the included plan.
        </p>
      ) : null}
      {planError || exportError ? (
        <p style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>
          {exportError ?? planError}
        </p>
      ) : null}
    </div>
  );
}
