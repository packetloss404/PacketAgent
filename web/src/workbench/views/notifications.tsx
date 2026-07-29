import { I, type IconKey } from "../icons";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";

interface AlertEntry {
  id: string;
  rule?: string;
  severity?: "low" | "medium" | "high" | "critical";
  state?: "active" | "acknowledged" | "resolved";
  firedAt?: string;
  detail?: string;
}

export function NotificationsView() {
  const alerts = useApiData<{ alerts?: AlertEntry[] } | AlertEntry[]>(
    () => api.listOperationsAlerts() as Promise<unknown> as Promise<{ alerts?: AlertEntry[] }>,
    [],
  );
  const list: AlertEntry[] = Array.isArray(alerts.data) ? alerts.data : (alerts.data?.alerts ?? []);
  const active = list.filter((a) => a.state === "active").length;

  // Channels surface comes from env-var configuration today (Slack webhook URL, alert webhook, email mode)
  const envVars = useApiData(() => api.listEnvVars(), []);
  const channels = (envVars.data ?? [])
    .filter((e) => /WEBHOOK_URL|EMAIL_MODE|ALERT|NOTIFY/i.test(e.key))
    .map((e) => ({
      id: e.id,
      name: e.key,
      kind: e.key.includes("SLACK") ? "slack" : e.key.includes("EMAIL") ? "email" : "webhook",
      target: e.valuePreview ?? "—",
      lastTested: e.updatedAt,
    }));

  return (
    <div style={{ padding: "26px 28px 60px", maxWidth: 1180 }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
        {active} active alert{active === 1 ? "" : "s"} · {list.length} total in window ·{" "}
        {channels.length} channel{channels.length === 1 ? "" : "s"} configured.
      </p>

      <div className="kicker" style={{ marginBottom: 8 }}>
        CHANNELS
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          marginBottom: 22,
        }}
      >
        {channels.map((c) => {
          const ico: IconKey =
            c.kind === "slack" ? "msg" : c.kind === "email" ? "inbox" : "webhook";
          const Ico = I[ico] || I.bell;
          return (
            <div key={c.id} className="card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Ico size={14} style={{ color: "var(--green)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="mono"
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: "var(--silver-50)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.name}
                  </div>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {c.kind} · {c.target}
                  </div>
                </div>
                <span className="pill good">
                  <span className="dot"></span>configured
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: "1px solid var(--line)",
                }}
              >
                <span className="mono muted" style={{ fontSize: 11 }}>
                  updated {new Date(c.lastTested).toLocaleDateString()}
                </span>
              </div>
            </div>
          );
        })}
        {channels.length === 0 && !envVars.loading && (
          <div className="card muted" style={{ padding: 14 }}>
            No notification channels configured. Add a webhook URL or alert env var to enable
            routing.
          </div>
        )}
      </div>

      <div className="kicker" style={{ marginBottom: 8 }}>
        RECENT ALERTS
      </div>
      {alerts.loading && <div className="muted">Loading…</div>}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Severity</th>
              <th>State</th>
              <th>Fired</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td className="mono" style={{ color: "var(--green)", fontSize: 12 }}>
                  {a.rule ?? a.id}
                </td>
                <td>
                  <span
                    className={`pill ${a.severity === "critical" || a.severity === "high" ? "danger" : a.severity === "medium" ? "warn" : "muted"}`}
                  >
                    {a.severity ?? "—"}
                  </span>
                </td>
                <td>
                  <span
                    className={`pill ${a.state === "active" ? "danger" : a.state === "acknowledged" ? "warn" : "good"}`}
                  >
                    <span className="dot"></span>
                    {a.state ?? "—"}
                  </span>
                </td>
                <td className="mono muted" style={{ fontSize: 11.5 }}>
                  {a.firedAt ?? "—"}
                </td>
                <td style={{ fontSize: 12.5 }}>{a.detail ?? ""}</td>
              </tr>
            ))}
            {list.length === 0 && !alerts.loading && (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No alerts in window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
