import { Link, useParams } from "react-router-dom";
import { I } from "../icons";
import { api } from "@/lib/api";
import { useApiData } from "../useApiData";
import { CHECKS, PREVIEW_TRUTH_COPY } from "./preview-copy";
import { formatRelativeTime } from "@/lib/format";

export function AppPreviewView() {
  const { workspaceId = "workspace", appId = "generated-app" } = useParams();
  const appName = titleFromSlug(appId);
  const publish = useApiData(() => api.getBuilderPublishState({ appId }), [appId]);
  const checkpoints = useApiData(() => api.listBuilderCheckpoints({ appId }), [appId]);
  const checkpointList = checkpoints.data?.checkpoints ?? [];
  const currentCheckpoint =
    checkpointList.find((checkpoint) => checkpoint.id === publish.data?.checkpointId) ??
    checkpointList.find((checkpoint) => checkpoint.id === checkpoints.data?.currentCheckpointId) ??
    checkpointList[0];

  return (
    <>
      <header className="flex items-center justify-between px-4 h-10 border-b border-line text-sm">
        <a href="/builder" className="text-silver-500 hover:text-silver-50">
          ← Back
        </a>
        <span className="text-silver-300">{appName}</span>
        <span className="w-12" />
      </header>
      <div style={{ padding: "26px 28px 60px", maxWidth: 1180 }}>
        <div className="kicker">Saved preview</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 0.85fr", gap: 28, marginTop: 18 }}>
          <div>
            <p className="kicker" style={{ color: "var(--silver-500)" }}>
              {workspaceId}
            </p>
            <h1 className="h1" style={{ fontSize: 32, marginTop: 6 }}>
              {appName}
            </h1>
            <p
              className="muted"
              style={{ fontSize: 13.5, lineHeight: 1.65, maxWidth: 560, marginTop: 10 }}
            >
              {PREVIEW_TRUTH_COPY}
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
              <Link to="/builder" className="btn btn-sm" style={{ textDecoration: "none" }}>
                <I.layout size={12} /> Builder
              </Link>
              <span className={`pill ${publish.data?.canPublish ? "good" : "warn"}`}>
                <span className="dot"></span>
                {publish.data?.canPublish ? "handoff ready" : (publish.data?.status ?? "checking")}
              </span>
            </div>
            {(publish.loading || checkpoints.loading) && (
              <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
                Loading checkpoint state…
              </p>
            )}
            {(publish.error || checkpoints.error) && (
              <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 14 }}>
                {publish.error ?? checkpoints.error}
              </p>
            )}
          </div>
          <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
            {currentCheckpoint && (
              <div className="card" style={{ padding: 14 }}>
                <p className="kicker" style={{ marginBottom: 4 }}>
                  Current checkpoint
                </p>
                <details>
                  <summary style={{ fontSize: 12, color: "var(--silver-200)", cursor: "pointer" }}>
                    Active save ·{" "}
                    {formatRelativeTime(currentCheckpoint.createdAt, { underMinute: "just-now" })}
                  </summary>
                  <p className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                    {currentCheckpoint.id}
                  </p>
                </details>
                <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {currentCheckpoint.label}
                </p>
              </div>
            )}
            {CHECKS.map((c) => {
              const Ico = I[c.icon];
              return (
                <div
                  key={c.label}
                  className="card"
                  style={{ padding: 14, display: "flex", gap: 10 }}
                >
                  <Ico size={16} style={{ color: "var(--green)", flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <p className="kicker" style={{ marginBottom: 4 }}>
                      {c.label}
                    </p>
                    <p style={{ fontSize: 13, color: "var(--silver-200)" }}>{c.value}</p>
                  </div>
                </div>
              );
            })}
            {publish.data?.nextActions?.slice(0, 3).map((action) => (
              <div key={action} className="card" style={{ padding: 14, display: "flex", gap: 10 }}>
                <I.arrow
                  size={16}
                  style={{ color: "var(--silver-400)", flexShrink: 0, marginTop: 2 }}
                />
                <p style={{ fontSize: 13, color: "var(--silver-200)" }}>{action}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function titleFromSlug(slug: string) {
  return (
    slug
      .split("-")
      .filter(Boolean)
      .map((w) => w[0]?.toUpperCase() + w.slice(1))
      .join(" ") || "Generated App"
  );
}
