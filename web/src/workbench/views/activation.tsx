import { I } from "../icons";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";

export function ActivationView() {
  const detail = useApiData(() => api.getActivationDetail(), []);
  const summary = detail.data?.activation?.summary;
  const items = summary?.items ?? [];
  const completed = items.filter(s => s.completed).length;
  const total = items.length || 7;
  const pct = summary?.progressPercent ?? Math.round((completed / total) * 100);
  const stage = summary?.stageLabel ?? "onboarding";

  return (
    <div style={{ padding: "32px 28px", maxWidth: 880 }}>
        <div className="kicker">ONBOARDING · STAGE: {stage.toUpperCase()}</div>
        <h1 className="h1" style={{ fontSize: 32, marginTop: 6 }}>Get to first value.</h1>
        <p style={{ fontSize: 14.5, color: "var(--silver-300)", marginTop: 6, marginBottom: 22 }}>
          PacketAgent flips a workspace to <span style={{ color: "var(--green)" }}>activated</span> after the team
          publishes an app and configures alerts. You're {pct}% of the way there.
        </p>

        {detail.loading && <div className="card muted" style={{ padding: 22 }}>Loading activation…</div>}
        {detail.error && <div className="card" style={{ padding: 22, color: "var(--danger)" }}>{detail.error}</div>}

        {summary && (
          <div className="card" style={{ padding: 22, marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 16 }}>
              <div style={{
                width: 76, height: 76, borderRadius: "50%",
                background: `conic-gradient(var(--green) 0% ${pct}%, var(--bg-elev) ${pct}% 100%)`,
                display: "grid", placeItems: "center", position: "relative",
              }}>
                <div style={{ position: "absolute", inset: 7, borderRadius: "50%", background: "var(--panel)", display: "grid", placeItems: "center", fontSize: 17, fontWeight: 600, color: "var(--green)" }}>{pct}%</div>
              </div>
              <div>
                <div className="h2">{completed} of {items.length} complete</div>
                <p className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                  {items.length - completed} step{items.length - completed === 1 ? "" : "s"} left
                  {summary.nextRecommendedAction ? ` · next: ${summary.nextRecommendedAction}` : ""}
                </p>
              </div>
            </div>

            {items.map((s, i) => (
              <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 0", borderTop: "1px solid var(--line)" }}>
                <div style={{
                  width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                  background: s.completed ? "var(--green)" : "transparent",
                  border: `1px solid ${s.completed ? "var(--green)" : "var(--line-3)"}`,
                  display: "grid", placeItems: "center",
                }}>
                  {s.completed ? <I.check size={13} stroke="#0E1A02" strokeWidth={3}/> : <span className="mono" style={{ fontSize: 11, color: "var(--silver-400)" }}>{i + 1}</span>}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, color: s.completed ? "var(--silver-300)" : "var(--silver-50)", textDecoration: s.completed ? "line-through" : "none" }}>{s.label}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{s.description}</div>
                </div>
                {!s.completed && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={async () => {
                      try { await api.completeOnboardingStep(s.key); await detail.refresh(); } catch (e) { console.error(e); }
                    }}
                  >
                    Mark done <I.arrow size={11}/>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="card" style={{ padding: 18 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>WHY THIS MATTERS</div>
          <p style={{ fontSize: 13.5, lineHeight: 1.65, color: "var(--silver-200)" }}>
            Each workspace passes through{" "}
            <span className="mono" style={{ color: "var(--green)" }}>onboarding → activating → activated</span>.
            The signals are real — agent runs, releases, alert routes — not vanity steps. We use them to
            decide when to surface advanced features (share tokens, audit log, op runbooks).
          </p>
        </div>
    </div>
  );
}
