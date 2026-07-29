import { I } from "../icons";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";

export function WebhooksView() {
  const agents = useApiData(() => api.listAgents(), []);
  const webhookAgents = (agents.data ?? []).filter((a) => a.triggerKind === "webhook");

  const events = [
    "run.started",
    "run.completed",
    "run.failed",
    "run.canceled",
    "release.confirmed",
    "release.rolled_back",
    "alert.fired",
    "alert.resolved",
    "agent.created",
    "agent.updated",
    "agent.deleted",
    "member.invited",
    "member.joined",
    "member.removed",
  ];

  return (
    <div style={{ padding: "26px 28px 60px", maxWidth: 1180 }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
        {webhookAgents.length} agent{webhookAgents.length === 1 ? "" : "s"} listening on webhook
        triggers · signed with HMAC-SHA256, retried with exponential backoff.
      </p>

      {agents.loading && <div className="muted">Loading…</div>}
      <div style={{ display: "grid", gap: 10, marginBottom: 22 }}>
        {webhookAgents.map((a) => (
          <div key={a.id} className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
              <I.webhook
                size={14}
                style={{ color: a.hasWebhookToken ? "var(--green)" : "var(--warn)" }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--silver-50)" }}>
                  {a.name}
                </div>
                <div className="mono muted" style={{ fontSize: 11.5 }}>
                  token: {a.webhookTokenPreview ?? "—"}
                </div>
              </div>
              <span className={`pill ${a.hasWebhookToken ? "good" : "warn"}`}>
                <span className="dot"></span>
                {a.hasWebhookToken ? "ready" : "needs token"}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  try {
                    await api.rotateAgentWebhook(a.id);
                    await agents.refresh();
                  } catch (e) {
                    console.error(e);
                  }
                }}
              >
                <I.refresh size={12} /> Rotate
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{ padding: "3px 8px", color: "var(--danger)" }}
                onClick={async () => {
                  try {
                    await api.removeAgentWebhook(a.id);
                    await agents.refresh();
                  } catch (e) {
                    console.error(e);
                  }
                }}
              >
                <I.trash size={12} />
              </button>
            </div>
          </div>
        ))}
        {webhookAgents.length === 0 && !agents.loading && (
          <div className="card muted" style={{ padding: 14 }}>
            No webhook-triggered agents configured.
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="h3" style={{ fontSize: 14, marginBottom: 10 }}>
          Available events
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          {events.length} events emitted by the workspace runtime.
        </p>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {events.map((e) => (
            <span
              key={e}
              className="mono"
              style={{
                fontSize: 11,
                padding: "3px 7px",
                background: "var(--bg-elev)",
                border: "1px solid var(--line)",
                borderRadius: 4,
                color: "var(--silver-200)",
              }}
            >
              {e}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
