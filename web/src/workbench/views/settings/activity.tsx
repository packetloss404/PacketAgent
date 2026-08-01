import { I } from "../../icons";
import { useNavigate } from "react-router-dom";
import { ADVANCED_GROUPS, type AdvancedEntry } from "./advanced";

export function AuditTab({
  data,
  loading,
}: {
  data: ReadonlyArray<{
    id: string;
    event: string;
    scope: string;
    occurredAt: string;
    actor: { type: string; displayName?: string };
    data: Record<string, unknown>;
  }> | null;
  loading: boolean;
}) {
  const list = data ?? [];
  return (
    <div>
      <h1 className="h1" style={{ fontSize: 24, marginBottom: 14 }}>
        Audit log
      </h1>
      {loading && <div className="muted">Loading…</div>}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Scope</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td className="mono muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                  {new Date(a.occurredAt).toLocaleString()}
                </td>
                <td className="mono" style={{ color: "var(--green)", fontSize: 11.5 }}>
                  {a.event}
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {a.actor.displayName ?? a.actor.type}
                </td>
                <td>
                  <span className="pill muted">{a.scope}</span>
                </td>
                <td style={{ fontSize: 12.5 }}>{summarizeData(a.data)}</td>
              </tr>
            ))}
            {list.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No audit entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdvancedTab({ canManageWorkspace }: { canManageWorkspace: boolean }) {
  const navigate = useNavigate();
  const groups = ADVANCED_GROUPS.map((group) => ({
    ...group,
    entries: group.entries.filter((entry) => canManageWorkspace || entry.owner !== "Admin"),
  })).filter((group) => group.entries.length > 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <div className="kicker">ADVANCED</div>
          <h1 className="h1" style={{ fontSize: 24, marginTop: 4 }}>
            {canManageWorkspace ? "Admin and operations tools" : "Operations tools"}
          </h1>
          <p
            className="muted"
            style={{ fontSize: 13, marginTop: 8, marginBottom: 0, maxWidth: 650 }}
          >
            {canManageWorkspace
              ? "These views are available when a workspace needs deeper control. Builders can stay focused on apps, agents, and runs until one of these tools is needed."
              : "Admin-only settings are hidden for your role. Workspace operations views remain available for day-to-day diagnostics."}
          </p>
        </div>
        <span className="pill warn" style={{ marginTop: 3 }}>
          ADVANCED
        </span>
      </div>

      <div style={{ display: "grid", gap: 18 }}>
        {groups.map((group) => (
          <section key={group.title}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
              <h2 className="h3" style={{ fontSize: 14 }}>
                {group.title}
              </h2>
              <span className="muted" style={{ fontSize: 12 }}>
                {group.note}
              </span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
                gap: 10,
              }}
            >
              {group.entries.map((entry) => (
                <AdvancedEntryCard
                  key={entry.path}
                  entry={entry}
                  onOpen={() => navigate(entry.path)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function AdvancedEntryCard({ entry, onOpen }: { entry: AdvancedEntry; onOpen: () => void }) {
  const EntryIcon = I[entry.icon];

  return (
    <button
      type="button"
      className="card"
      onClick={onOpen}
      style={{
        width: "100%",
        minHeight: 126,
        padding: 14,
        textAlign: "left",
        color: "inherit",
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            border: "1px solid var(--line-2)",
            background: "var(--bg-elev)",
            display: "grid",
            placeItems: "center",
            color: "var(--green)",
            flexShrink: 0,
          }}
        >
          <EntryIcon size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--silver-50)" }}>
            {entry.label}
          </div>
          <div className="mono muted" style={{ fontSize: 10.5 }}>
            {entry.owner} tool
          </div>
        </div>
        <I.chevRight size={14} style={{ color: "var(--silver-400)" }} />
      </div>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        {entry.description}
      </div>
      <div className="mono" style={{ marginTop: "auto", fontSize: 11, color: "var(--silver-300)" }}>
        {entry.path}
      </div>
    </button>
  );
}

function summarizeData(data: Record<string, unknown>): string {
  const keys = Object.keys(data ?? {});
  if (keys.length === 0) return "—";
  const first = keys[0]!;
  const val = data[first];
  return `${first}: ${typeof val === "object" ? JSON.stringify(val).slice(0, 60) : String(val).slice(0, 60)}`;
}
