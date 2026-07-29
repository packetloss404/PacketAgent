import { AdminToggle, AdminField } from "./admin-controls";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";

export function RateLimitsView() {
  const apiKeys = useApiData(() => api.listApiKeys(), []);
  const agents = useApiData(() => api.listAgents(), []);
  const providers = useApiData(() => api.listProviders(), []);

  const rows: { scope: string; status: "ok" | "warning" }[] = [];
  for (const k of apiKeys.data ?? []) rows.push({ scope: `API key · ${k.label}`, status: "ok" });
  for (const a of agents.data ?? []) rows.push({ scope: `Agent · ${a.name}`, status: "ok" });
  for (const p of providers.data ?? [])
    rows.push({
      scope: `Provider · ${p.name}`,
      status: p.status === "connected" ? "ok" : "warning",
    });

  return (
    <div style={{ padding: "26px 28px 60px", maxWidth: 1180 }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
        Defaults applied per minute and per day · enforced by the distributed limiter · 429 returned
        on overflow with Retry-After.
      </p>

      <div className="card" style={{ overflow: "hidden", marginBottom: 18 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Per-minute</th>
              <th>Daily tokens</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ color: "var(--silver-50)", fontWeight: 500 }}>{r.scope}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  60 req/min · default
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  500k · default
                </td>
                <td>
                  {r.status === "warning" ? (
                    <span className="pill warn">
                      <span className="dot"></span>provider not connected
                    </span>
                  ) : (
                    <span className="pill good">
                      <span className="dot"></span>ok
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No rate-limit scopes configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="h3" style={{ fontSize: 14, marginBottom: 6 }}>
            Defaults
          </div>
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 14 }}>
            Applied to any new key, agent, or provider unless overridden.
          </p>
          <AdminField label="Default RPM (API key)" value="60 req/min" />
          <div style={{ height: 10 }}></div>
          <AdminField label="Default daily tokens" value="500,000" />
          <div style={{ height: 10 }}></div>
          <AdminField label="Burst window" value="10s sliding" />
        </div>
        <div className="card" style={{ padding: 18 }}>
          <div className="h3" style={{ fontSize: 14, marginBottom: 6 }}>
            Overflow behavior
          </div>
          <AdminToggle
            label="Return 429 with Retry-After"
            sub="Standard backpressure for API consumers"
            on={true}
          />
          <AdminToggle
            label="Queue overflow up to 100 events"
            sub="Buffered, replayed when budget refills"
            on={true}
          />
          <AdminToggle
            label="Page on sustained throttle (5 min)"
            sub="Routes to Notifications · alert.fired"
            on={false}
          />
        </div>
      </div>
    </div>
  );
}
