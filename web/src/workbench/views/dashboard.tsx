import { useNavigate } from "react-router-dom";
import { I } from "../icons";
import { Topbar, Stat, PanelHeader } from "../Shell";
import { useApiData } from "../useApiData";
import { useUser, useWorkbench } from "../workbench-state";
import { api } from "@/lib/api";

export function DashboardView() {
  const navigate = useNavigate();
  const setActive = (key: string) => navigate(`/${key}`);
  const user = useUser();
  const onboarding = useWorkbench().session.onboarding;

  const bootstrap = useApiData(() => api.getBootstrap(), []);
  const agents = useApiData(() => api.listAgents(), []);
  const runs = useApiData(() => api.listAgentRuns(), []);
  const usage = useApiData(() => api.getUsageSummary(), []);
  const activity = useApiData(() => api.listActivity(), []);

  const activeAgents = (agents.data ?? []).filter((a) => a.status === "active").length;
  const totalAgents = (agents.data ?? []).length;
  const runs24h = (runs.data ?? []).filter((r) => {
    if (!r.startedAt) return false;
    return Date.now() - new Date(r.startedAt).getTime() < 24 * 60 * 60 * 1000;
  });
  const successRuns = runs24h.filter((r) => r.status === "success").length;
  const failedRuns = runs24h.filter((r) => r.status === "failed").length;
  const retryRuns = runs24h.filter((r) => r.status === "running").length;
  const spend = usage.data?.last24h.costUsd ?? 0;

  const completedSteps = onboarding.completedSteps?.length ?? 0;
  const totalSteps = bootstrap.data?.activation?.summary?.items?.length ?? 7;
  const pct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const nextAction =
    bootstrap.data?.activation?.summary?.nextRecommendedAction ?? "Continue activation";

  const recentAgents = (agents.data ?? []).slice(0, 5);
  const firstName = user.displayName.split(/\s+/)[0] ?? user.displayName;

  return (
    <>
      <Topbar
        crumbs={["__WS__", "Dashboard"]}
        actions={
          <>
            <button
              className="top-btn"
              onClick={() => {
                void bootstrap.refresh();
                void agents.refresh();
                void runs.refresh();
                void usage.refresh();
                void activity.refresh();
              }}
            >
              <I.refresh size={13} /> Refresh
            </button>
            <button className="top-btn" onClick={() => setActive("builder")}>
              <I.plus size={13} /> New build
            </button>
          </>
        }
      />
      <div style={{ padding: "32px 28px 60px", maxWidth: 1180 }}>
        <div className="kicker">DASHBOARD</div>
        <h1 className="h1" style={{ fontSize: 30, marginTop: 4, marginBottom: 4 }}>
          Welcome back, {firstName}.
        </h1>
        <p className="muted" style={{ fontSize: 13.5, marginBottom: 22 }}>
          {completedSteps} / {totalSteps} activation steps complete · {runs24h.length} runs in the
          last 24 hours.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 10,
            marginBottom: 18,
          }}
        >
          <Stat
            label="Active agents"
            value={String(activeAgents)}
            sub={`of ${totalAgents} registered`}
            tone={activeAgents > 0 ? "good" : "default"}
          />
          <Stat
            label="Runs · 24h"
            value={String(runs24h.length)}
            sub={`${successRuns} success · ${failedRuns} failed · ${retryRuns} running`}
          />
          <Stat
            label="Total agents"
            value={String(totalAgents)}
            sub={`${(agents.data ?? []).filter((a) => a.status === "paused").length} paused`}
          />
          <Stat
            label="Spend · 24h"
            value={`$${spend.toFixed(2)}`}
            sub={usage.data ? `${usage.data.last24h.calls} calls` : "—"}
            tone={spend < 5 ? "good" : "default"}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
          <div className="card" style={{ overflow: "hidden" }}>
            <PanelHeader
              title="Recent agents"
              sub="Pick up where you left off"
              action={
                <button className="btn-ghost btn btn-sm" onClick={() => setActive("agents")}>
                  View all
                </button>
              }
            />
            {agents.loading && (
              <div style={{ padding: 16 }} className="muted">
                Loading…
              </div>
            )}
            {agents.error && (
              <div style={{ padding: 16, color: "var(--danger)" }}>{agents.error}</div>
            )}
            {!agents.loading && !agents.error && recentAgents.length === 0 && (
              <div style={{ padding: 16 }} className="muted">
                No agents yet — create your first one.
              </div>
            )}
            {recentAgents.map((a, i) => (
              <div
                key={a.id}
                onClick={() => setActive("agents")}
                style={{
                  display: "grid",
                  gridTemplateColumns: "26px 1fr auto auto",
                  alignItems: "center",
                  gap: 12,
                  padding: "11px 16px",
                  borderTop: i === 0 ? "none" : "1px solid var(--line)",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    background: "var(--bg-elev)",
                    border: "1px solid var(--line)",
                    display: "grid",
                    placeItems: "center",
                    color: "var(--green)",
                  }}
                >
                  <I.bot size={13} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--silver-500)" }}>
                    {a.model ?? "—"}{" "}
                    {a.schedule ? `· ${a.schedule}` : a.triggerKind ? `· ${a.triggerKind}` : ""}
                  </div>
                </div>
                <span
                  className={`pill ${a.status === "active" ? "good" : a.status === "paused" ? "warn" : "muted"}`}
                >
                  <span className="dot"></span>
                  {a.status}
                </span>
                <span className="mono muted" style={{ fontSize: 11 }}>
                  {formatRelative(a.updatedAt)}
                </span>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 16 }}>
            <div className="card" style={{ padding: 16 }}>
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
              >
                <div className="kicker">ACTIVATION</div>
                <span className="mono" style={{ fontSize: 11, color: "var(--silver-300)" }}>
                  {completedSteps} / {totalSteps}
                </span>
              </div>
              <div
                style={{
                  marginTop: 8,
                  height: 6,
                  background: "var(--bg-elev)",
                  borderRadius: 3,
                  overflow: "hidden",
                  border: "1px solid var(--line)",
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: "linear-gradient(90deg, var(--green-deep), var(--green))",
                  }}
                ></div>
              </div>
              <div style={{ marginTop: 12, fontSize: 13 }}>
                Next: <span style={{ color: "var(--green)" }}>{nextAction}</span>
              </div>
              <button
                onClick={() => setActive("activation")}
                className="btn btn-sm"
                style={{ marginTop: 10 }}
              >
                Open checklist <I.arrow size={12} />
              </button>
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <PanelHeader title="Recent activity" />
              <div style={{ padding: "0 16px 12px", maxHeight: 240, overflow: "auto" }}>
                {activity.loading && (
                  <div style={{ padding: "8px 0" }} className="muted">
                    Loading…
                  </div>
                )}
                {!activity.loading &&
                  (activity.data ?? []).slice(0, 6).map((a, i) => (
                    <div
                      key={a.id}
                      style={{
                        display: "flex",
                        gap: 10,
                        padding: "8px 0",
                        borderTop: i === 0 ? "none" : "1px solid var(--line)",
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: 10.5,
                          color: "var(--silver-500)",
                          width: 70,
                          flexShrink: 0,
                          paddingTop: 2,
                        }}
                      >
                        {formatRelative(a.occurredAt)}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5 }}>{a.event}</div>
                        <div
                          className="mono"
                          style={{ fontSize: 10.5, color: "var(--silver-500)" }}
                        >
                          {a.scope} · {a.actor.displayName ?? a.actor.type}
                        </div>
                      </div>
                    </div>
                  ))}
                {!activity.loading && (activity.data ?? []).length === 0 && (
                  <div style={{ padding: "8px 0" }} className="muted">
                    No recent activity.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function formatRelative(iso: string | undefined | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
