import { I } from "../icons";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";
import type { ProviderRecord } from "@/lib/types";

export function IntegrationsView() {
  const providers = useApiData(() => api.listProviders(), []);
  const tools = useApiData(() => api.listTools(), []);
  const envVars = useApiData(() => api.listEnvVars(), []);
  const usage = useApiData(() => api.getUsageSummary(), []);

  const providerList = providers.data ?? [];
  const toolList = tools.data ?? [];
  const envList = envVars.data ?? [];
  const callsByProvider = new Map<string, { calls: number; cost: number }>();
  for (const c of usage.data?.byProvider ?? []) {
    callsByProvider.set(c.provider, { calls: c.calls, cost: c.costUsd });
  }

  return (
    <div style={{ padding: "26px 28px", maxWidth: 1180 }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
        {providerList.filter((p) => p.status === "connected").length} connected ·{" "}
        {providerList.filter((p) => p.status === "missing_key").length} missing key · keys live in
        your self-hosted vault.
      </p>

      <div className="kicker" style={{ marginBottom: 8 }}>
        MODEL PROVIDERS
      </div>
      {providers.loading && <div className="muted">Loading…</div>}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 10,
          marginBottom: 24,
        }}
      >
        {providerList.map((p) => {
          const stats = callsByProvider.get(p.kind) ?? { calls: 0, cost: 0 };
          return <ProviderCard key={p.id} p={p} calls={stats.calls} cost={stats.cost} />;
        })}
        {providerList.length === 0 && !providers.loading && (
          <div className="card muted" style={{ padding: 16 }}>
            No providers configured.
          </div>
        )}
      </div>

      <div className="kicker" style={{ marginBottom: 8 }}>
        TOOLS · {toolList.length} REGISTERED
      </div>
      <div className="card" style={{ overflow: "hidden", marginBottom: 24 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Category</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {toolList.map((t) => (
              <tr key={t.name}>
                <td className="mono" style={{ color: "var(--silver-50)" }}>
                  {t.name}
                </td>
                <td>
                  <span
                    className={`pill ${t.side === "write" ? "warn" : t.side === "exec" ? "danger" : "info"}`}
                  >
                    {t.side}
                  </span>
                </td>
                <td className="muted" style={{ fontSize: 12.5 }}>
                  {t.description}
                </td>
              </tr>
            ))}
            {toolList.length === 0 && !tools.loading && (
              <tr>
                <td colSpan={3} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No tools registered.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="kicker" style={{ marginBottom: 8 }}>
        ENVIRONMENT · {envList.length} VARIABLES
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Key</th>
              <th>Scope</th>
              <th>Value</th>
              <th>Management</th>
            </tr>
          </thead>
          <tbody>
            {envList.map((e) => (
              <tr key={e.id}>
                <td className="mono" style={{ color: "var(--silver-50)" }}>
                  {e.key}
                </td>
                <td>
                  <span className="pill muted">{e.scope}</span>
                </td>
                <td
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: e.secret ? "var(--silver-400)" : "var(--silver-200)",
                  }}
                >
                  {e.secret && (
                    <I.shield
                      size={11}
                      style={{ verticalAlign: "-2px", marginRight: 4, color: "var(--warn)" }}
                    />
                  )}
                  {e.valuePreview ?? "•••"}
                </td>
                <td className="muted" style={{ fontSize: 11.5 }}>
                  API-managed
                </td>
              </tr>
            ))}
            {envList.length === 0 && !envVars.loading && (
              <tr>
                <td colSpan={4} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No environment variables configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProviderCard({ p, calls, cost }: { p: ProviderRecord; calls: number; cost: number }) {
  const tone = p.status === "connected" ? "good" : p.status === "missing_key" ? "warn" : "muted";
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: "var(--bg-elev)",
            border: "1px solid var(--line)",
            display: "grid",
            placeItems: "center",
            fontSize: 12,
            fontWeight: 700,
            color: p.status === "connected" ? "var(--green)" : "var(--silver-300)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {p.name.slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--silver-50)" }}>{p.name}</div>
          <div className="mono muted" style={{ fontSize: 11 }}>
            {p.kind} · {p.defaultModel}
          </div>
        </div>
        <span className={`pill ${tone}`}>
          <span className="dot"></span>
          {p.status.replace("_", " ")}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 12,
          paddingTop: 10,
          borderTop: "1px solid var(--line)",
        }}
      >
        <div className="mono muted" style={{ fontSize: 11 }}>
          {calls > 0 ? `${calls.toLocaleString()} calls · 7d` : "no calls"}
        </div>
        <div className="mono muted" style={{ fontSize: 11 }}>
          ${cost.toFixed(2)} · 7d
        </div>
        <span className="mono muted" style={{ marginLeft: "auto", fontSize: 10.5 }}>
          self-hosted config
        </span>
      </div>
    </div>
  );
}
