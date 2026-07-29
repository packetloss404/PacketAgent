import { I } from "../../icons";
import type { AppBuilderApiRoute, AppBuilderDataEntity, AppBuilderPageDraft } from "@/lib/types";

export function PageCard({ page }: { page: AppBuilderPageDraft }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--green)" }}>
          {page.route}
        </span>
        <span
          className={`pill ${page.access === "private" ? "good" : page.access === "admin" ? "warn" : "muted"}`}
        >
          <span className="dot"></span>
          {page.access}
        </span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--silver-50)", marginBottom: 4 }}>
        {page.name}
      </div>
      <p className="muted" style={{ fontSize: 11.5 }}>
        {page.purpose}
      </p>
    </div>
  );
}

export function RouteRow({ route }: { route: AppBuilderApiRoute }) {
  return (
    <tr>
      <td>
        <span
          className={`pill ${route.method === "GET" ? "info" : route.method === "DELETE" ? "danger" : "warn"}`}
        >
          {route.method}
        </span>
      </td>
      <td className="mono" style={{ fontSize: 11.5, color: "var(--silver-50)" }}>
        {route.path}
      </td>
      <td>
        <span className="pill muted">{route.access}</span>
      </td>
      <td className="muted" style={{ fontSize: 12 }}>
        {route.purpose}
      </td>
    </tr>
  );
}

export function DataCard({ entity }: { entity: AppBuilderDataEntity }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <I.database size={13} style={{ color: "var(--green)" }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--silver-50)" }}>
          {entity.name}
        </span>
        <span className="mono muted" style={{ fontSize: 10.5, marginLeft: "auto" }}>
          {entity.fields.length} fields
        </span>
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {entity.fields.slice(0, 6).map((f) => (
          <span
            key={f.name}
            className="mono"
            style={{
              fontSize: 10.5,
              padding: "2px 6px",
              background: "var(--bg-elev)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              color: "var(--silver-200)",
            }}
          >
            {f.name}: <span style={{ color: "var(--silver-400)" }}>{f.type}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
