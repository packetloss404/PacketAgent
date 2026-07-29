import { I } from "../../../icons";
import type { AppBuilderIterationResult, AppBuilderSmokeBuildStatus } from "@/lib/types";

export function SmokeTab({ smoke }: { smoke: AppBuilderSmokeBuildStatus | null }) {
  if (!smoke) {
    return (
      <div style={{ padding: 22 }}>
        <div className="card muted" style={{ padding: 22, textAlign: "center" }}>
          No smoke / build status yet. Approve the draft to run the first build.
        </div>
      </div>
    );
  }
  return (
    <div style={{ padding: 22, maxWidth: 800 }}>
      <div className="kicker">Quality checks</div>
      <div
        style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4, marginBottom: 14 }}
      >
        <h2 className="h2">{smoke.message}</h2>
        <span
          className={`pill ${smoke.status === "pass" ? "good" : smoke.status === "fail" ? "danger" : "warn"}`}
        >
          <span className="dot"></span>
          {smoke.status}
        </span>
      </div>

      {smoke.blockers.length > 0 && (
        <div
          className="card"
          style={{
            padding: 12,
            marginBottom: 14,
            borderColor: "rgba(242,107,92,0.3)",
            background: "rgba(242,107,92,0.06)",
          }}
        >
          <div className="kicker" style={{ marginBottom: 6, color: "var(--danger)" }}>
            Blockers · {smoke.blockers.length}
          </div>
          {smoke.blockers.map((b, i) => (
            <div key={i} className="mono" style={{ fontSize: 11.5, color: "var(--danger)" }}>
              · {b}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ overflow: "hidden" }}>
        {smoke.checks.map((c, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 16px",
              borderTop: i === 0 ? "none" : "1px solid var(--line)",
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: 5,
                background:
                  c.status === "pass"
                    ? "rgba(184,242,92,0.1)"
                    : c.status === "fail"
                      ? "rgba(242,107,92,0.1)"
                      : "rgba(242,196,92,0.1)",
                border: `1px solid ${c.status === "pass" ? "var(--green-deep)" : c.status === "fail" ? "var(--danger)" : "var(--warn)"}`,
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              {c.status === "pass" ? (
                <I.check size={11} stroke="var(--green)" strokeWidth={2.5} />
              ) : (
                <I.alert size={11} stroke={c.status === "fail" ? "var(--danger)" : "var(--warn)"} />
              )}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: "var(--silver-100)" }}>{c.name}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {c.detail}
              </div>
            </div>
            <span
              className={`pill ${c.status === "pass" ? "good" : c.status === "fail" ? "danger" : "warn"}`}
            >
              {c.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LogsTab({ iteration }: { iteration: AppBuilderIterationResult | null }) {
  const logs = iteration?.logs ?? [];
  return (
    <div style={{ padding: 18 }}>
      <div
        className="card"
        style={{
          padding: 14,
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          lineHeight: 1.7,
          background: "var(--ink)",
          minHeight: 200,
        }}
      >
        {logs.length === 0 && (
          <div className="muted" style={{ textAlign: "center", padding: 22 }}>
            No iteration logs yet.
          </div>
        )}
        {logs.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 10 }}>
            <span style={{ color: "var(--silver-500)" }}>
              {new Date(l.at).toLocaleTimeString()}
            </span>
            <span
              style={{
                color:
                  l.level === "warn"
                    ? "var(--warn)"
                    : l.level === "error"
                      ? "var(--danger)"
                      : "var(--green)",
                width: 50,
              }}
            >
              {l.level}
            </span>
            <span style={{ color: "var(--silver-200)", flex: 1 }}>{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
