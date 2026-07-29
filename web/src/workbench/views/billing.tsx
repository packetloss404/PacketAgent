import { I } from "../icons";
import { PanelHeader } from "../Shell";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";
import { useNavigate } from "react-router-dom";

export function BillingView() {
  const navigate = useNavigate();
  const usage = useApiData(() => api.getUsageSummary(), []);
  const members = useApiData(() => api.listWorkspaceMembers(), []);
  const agents = useApiData(() => api.listAgents(), []);
  const runs = useApiData(() => api.listAgentRuns(), []);

  const memberCount = members.data?.members.length ?? 0;
  const totalCost = usage.data?.totalCostUsd ?? 0;
  const last24h = usage.data?.last24h.costUsd ?? 0;
  const totalCalls = usage.data?.totalCalls ?? 0;
  const byProvider = usage.data?.byProvider ?? [];
  const totalProviderCost = byProvider.reduce((acc, p) => acc + p.costUsd, 0) || 1;

  // Compute cost-by-agent from agent runs
  const agentNames = new Map<string, string>();
  for (const a of agents.data ?? []) agentNames.set(a.id, a.name);
  const byAgent = new Map<string, { runs: number; cost: number }>();
  for (const r of runs.data ?? []) {
    if (!r.agentId) continue;
    const cur = byAgent.get(r.agentId) ?? { runs: 0, cost: 0 };
    cur.runs += 1;
    cur.cost += r.costUsd ?? 0;
    byAgent.set(r.agentId, cur);
  }
  const agentCosts = Array.from(byAgent.entries())
    .map(([id, v]) => ({ id, name: agentNames.get(id) ?? id, runs: v.runs, cost: v.cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6);

  return (
    <div style={{ padding: "26px 28px 60px", maxWidth: 1180 }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
        ${totalCost.toFixed(2)} all-time · ${last24h.toFixed(2)} last 24 hours · {totalCalls}{" "}
        provider calls · {memberCount} member{memberCount === 1 ? "" : "s"}.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="kicker">SEATS</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
            <div style={{ fontSize: 28, fontWeight: 500, letterSpacing: "-0.02em" }}>
              {memberCount}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              active members
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: 12 }}
            onClick={() => navigate("/settings")}
          >
            <I.plus size={12} /> Manage members
          </button>
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div className="kicker">SPEND · 24H</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
            <div
              style={{
                fontSize: 28,
                fontWeight: 500,
                letterSpacing: "-0.02em",
                color: "var(--green)",
              }}
            >
              ${last24h.toFixed(2)}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {usage.data?.last24h.calls ?? 0} calls
            </div>
          </div>
          <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
            Tokens: {(usage.data?.totalPromptTokens ?? 0).toLocaleString()} prompt ·{" "}
            {(usage.data?.totalCompletionTokens ?? 0).toLocaleString()} completion
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <PanelHeader title="Spend by provider" />
          <div style={{ padding: "8px 16px 14px" }}>
            {byProvider.length === 0 && !usage.loading && (
              <div className="muted" style={{ padding: "12px 0", fontSize: 12.5 }}>
                No provider activity yet.
              </div>
            )}
            {byProvider.map((p) => (
              <div
                key={p.provider}
                style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--silver-50)" }}>
                    {p.provider}
                  </div>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {p.calls.toLocaleString()} calls
                  </div>
                  <div
                    className="mono"
                    style={{ marginLeft: "auto", fontSize: 12, color: "var(--silver-100)" }}
                  >
                    ${p.costUsd.toFixed(2)}
                  </div>
                </div>
                <div
                  style={{
                    marginTop: 6,
                    height: 4,
                    background: "var(--bg-elev)",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${(p.costUsd / totalProviderCost) * 100}%`,
                      height: "100%",
                      background: "var(--green)",
                    }}
                  ></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <PanelHeader title="Spend by agent" />
          <table className="tbl">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Runs</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {agentCosts.map((a) => (
                <tr key={a.id}>
                  <td style={{ color: "var(--silver-50)", fontWeight: 500 }}>{a.name}</td>
                  <td className="mono muted" style={{ fontSize: 12 }}>
                    {a.runs}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    ${a.cost.toFixed(2)}
                  </td>
                </tr>
              ))}
              {agentCosts.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted" style={{ padding: 18, textAlign: "center" }}>
                    No agent runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="kicker" style={{ marginBottom: 8 }}>
        SPEND BY ROUTE
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Route</th>
              <th>Calls</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {(usage.data?.byRoute ?? []).map((r) => (
              <tr key={r.routeKey}>
                <td className="mono" style={{ color: "var(--silver-50)" }}>
                  {r.routeKey}
                </td>
                <td className="mono muted" style={{ fontSize: 12 }}>
                  {r.calls}
                </td>
                <td className="mono">${r.costUsd.toFixed(2)}</td>
              </tr>
            ))}
            {(usage.data?.byRoute ?? []).length === 0 && !usage.loading && (
              <tr>
                <td colSpan={3} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No route activity yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
