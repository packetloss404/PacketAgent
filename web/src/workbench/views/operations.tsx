import { I } from "../icons";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";

interface SubsystemHealth {
  name: string;
  status: "ok" | "degraded" | "down" | "disabled";
  detail: string;
  checkedAt?: string;
}

interface HealthReport {
  generatedAt?: string;
  overall?: SubsystemHealth["status"];
  subsystems?: SubsystemHealth[];
}

interface AlertEntry {
  id: string;
  rule?: string;
  severity?: "low" | "medium" | "high" | "critical";
  state?: "active" | "acknowledged" | "resolved";
  firedAt?: string;
  detail?: string;
}

interface JobMetricEntry {
  type: string;
  lastDurationMs?: number;
  lastMs?: number;
  avgMs?: number;
  p95Ms?: number;
  count24h?: number;
  count?: number;
}

export function OperationsView() {
  const health = useApiData<HealthReport>(
    () => api.getOperationsHealth() as Promise<HealthReport>,
    [],
  );
  const alerts = useApiData<{ alerts?: AlertEntry[] } | AlertEntry[]>(
    () => api.listOperationsAlerts() as Promise<unknown> as Promise<{ alerts?: AlertEntry[] }>,
    [],
  );
  const jobs = useApiData<{ history?: JobMetricEntry[] } | JobMetricEntry[]>(
    () =>
      api.getOperationsJobMetrics() as Promise<unknown> as Promise<{ history?: JobMetricEntry[] }>,
    [],
  );

  const subsystems = health.data?.subsystems ?? [];
  const okCount = subsystems.filter((s) => s.status === "ok").length;
  const alertList: AlertEntry[] = Array.isArray(alerts.data)
    ? alerts.data
    : (alerts.data?.alerts ?? []);
  const activeAlerts = alertList.filter((a) => a.state === "active").length;
  const jobList: JobMetricEntry[] = Array.isArray(jobs.data)
    ? jobs.data
    : (jobs.data?.history ?? []);

  return (
    <div style={{ padding: "26px 28px", maxWidth: 1200 }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
        {okCount} of {subsystems.length || "—"} subsystems healthy · {activeAlerts} active alert
        {activeAlerts === 1 ? "" : "s"}
      </p>

      <div className="kicker" style={{ marginBottom: 8 }}>
        SUBSYSTEMS
      </div>
      {health.loading && (
        <div className="muted" style={{ marginBottom: 24 }}>
          Loading…
        </div>
      )}
      {health.error && (
        <div className="card" style={{ padding: 16, color: "var(--danger)", marginBottom: 24 }}>
          {health.error}
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          marginBottom: 24,
        }}
      >
        {subsystems.map((s) => (
          <div key={s.name} className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span
                className={`pill ${s.status === "ok" ? "good" : s.status === "degraded" ? "warn" : s.status === "down" ? "danger" : "muted"}`}
              >
                <span className="dot"></span>
                {s.status}
              </span>
              <span
                style={{ fontSize: 13, fontWeight: 500, color: "var(--silver-50)", marginLeft: 4 }}
              >
                {s.name.replace(/_/g, " ")}
              </span>
            </div>
            <div className="mono muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              {s.detail}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>
            ALERTS · {activeAlerts} ACTIVE
          </div>
          {alerts.loading && <div className="muted">Loading…</div>}
          {alertList.length === 0 && !alerts.loading && (
            <div className="card muted" style={{ padding: 16 }}>
              No alerts.
            </div>
          )}
          {alertList.map((a) => (
            <div key={a.id} className="card" style={{ padding: 13, marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <I.alert
                  size={14}
                  style={{
                    color:
                      a.severity === "high" || a.severity === "critical"
                        ? "var(--danger)"
                        : a.severity === "medium"
                          ? "var(--warn)"
                          : "var(--silver-400)",
                  }}
                />
                <div style={{ flex: 1 }}>
                  <div
                    className="mono"
                    style={{ fontSize: 12.5, color: "var(--silver-50)", fontWeight: 500 }}
                  >
                    {a.rule ?? a.id}
                  </div>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {a.firedAt ?? ""}
                  </div>
                </div>
                <span
                  className={`pill ${a.state === "active" ? "danger" : a.state === "acknowledged" ? "warn" : "good"}`}
                >
                  <span className="dot"></span>
                  {a.state ?? "—"}
                </span>
              </div>
              {a.detail && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6, paddingLeft: 22 }}>
                  {a.detail}
                </div>
              )}
            </div>
          ))}
        </div>

        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>
            JOB METRICS · LAST 24H
          </div>
          {jobs.loading && <div className="muted">Loading…</div>}
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Last</th>
                  <th>Avg</th>
                  <th>p95</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {jobList.map((j) => {
                  const last = j.lastMs ?? j.lastDurationMs ?? 0;
                  const p95 = j.p95Ms ?? 0;
                  return (
                    <tr key={j.type}>
                      <td className="mono" style={{ color: "var(--silver-50)", fontSize: 12 }}>
                        {j.type}
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {last}ms
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {j.avgMs ?? 0}ms
                      </td>
                      <td
                        className="mono"
                        style={{
                          fontSize: 11.5,
                          color: p95 > 1000 ? "var(--warn)" : "var(--silver-200)",
                        }}
                      >
                        {p95}ms
                      </td>
                      <td className="mono muted" style={{ fontSize: 11.5 }}>
                        {j.count24h ?? j.count ?? 0}
                      </td>
                    </tr>
                  );
                })}
                {jobList.length === 0 && !jobs.loading && (
                  <tr>
                    <td colSpan={5} className="muted" style={{ padding: 18, textAlign: "center" }}>
                      No job metrics yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
