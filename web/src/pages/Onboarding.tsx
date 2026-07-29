import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { BootstrapPayload } from "@/lib/types";
import { useAuth } from "@/context/auth-state";
import { I } from "@/workbench/icons";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refreshSession } = useAuth();
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getBootstrap()
      .then(setBootstrap)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const next = searchParams.get("next");

  const completeStep = async (stepKey: string) => {
    setSaving(stepKey);
    setError(null);
    try {
      await api.completeOnboardingStep(stepKey);
      await refreshSession();
      const nextBootstrap = await api.getBootstrap();
      setBootstrap(nextBootstrap);
      if (nextBootstrap.onboarding.status === "completed") {
        navigate(next && next.startsWith("/") ? next : "/", { replace: true });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div
        className="wb-root wb-root wb-root"
        style={{
          height: "100vh",
          display: "grid",
          placeItems: "center",
          color: "var(--silver-300)",
        }}
      >
        Loading onboarding…
      </div>
    );
  }
  if (!bootstrap) {
    return (
      <div
        className="wb-root wb-root wb-root"
        style={{ height: "100vh", display: "grid", placeItems: "center", color: "var(--danger)" }}
      >
        {error || "Failed to load onboarding."}
      </div>
    );
  }

  const items = bootstrap.activation.summary.items;
  const completed = items.filter((i) => i.completed).length;
  const total = items.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const remaining = items.filter((i) => !i.completed);

  return (
    <div className="wb-root wb-root wb-root" style={{ height: "100vh", overflow: "auto" }}>
      <div
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(900px 500px at 50% -10%, rgba(184,242,92,0.06), transparent 60%), var(--bg)",
          padding: "40px 32px",
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            display: "grid",
            gridTemplateColumns: "1.1fr 0.9fr",
            gap: 28,
          }}
        >
          <section className="card" style={{ padding: 32 }}>
            <span className="pill good">
              <span className="dot"></span>
              <I.sparkle size={11} /> Guided setup
            </span>
            <h1 className="h1" style={{ fontSize: 28, marginTop: 16, marginBottom: 10 }}>
              Complete the remaining PacketAgent setup steps.
            </h1>
            <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
              The current step and completion state are persisted on the server. Each completion
              updates the activation engine directly, so this flow stays aligned with the dashboard
              and settings views.
            </p>

            <div style={{ marginTop: 22 }}>
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
              >
                <div className="kicker">PROGRESS</div>
                <span className="mono" style={{ fontSize: 11, color: "var(--silver-300)" }}>
                  {completed} / {total}
                </span>
              </div>
              <div
                style={{
                  marginTop: 8,
                  height: 6,
                  background: "var(--bg-elev)",
                  borderRadius: 3,
                  overflow: "hidden",
                  border: "1px solid var(--line)",
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: "linear-gradient(90deg, var(--green-deep), var(--green))",
                  }}
                />
              </div>
            </div>

            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 8 }}>
              {items.map((item) => (
                <div
                  key={item.key}
                  className="card"
                  style={{ padding: "12px 14px", background: "var(--bg-elev)" }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--silver-50)" }}>
                        {item.label}
                      </div>
                      <div
                        className="muted"
                        style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5 }}
                      >
                        {item.description}
                      </div>
                    </div>
                    <span className={`pill ${item.completed ? "good" : "muted"}`}>
                      <span className="dot"></span>
                      {item.completed ? "complete" : "pending"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="card" style={{ padding: 32, alignSelf: "start" }}>
            <div className="kicker">ONBOARDING</div>
            <h2 className="h2" style={{ fontSize: 22, marginTop: 6 }}>
              Current step
            </h2>
            <p className="muted mono" style={{ marginTop: 8, fontSize: 12.5 }}>
              {bootstrap.onboarding.currentStep.replaceAll("_", " ")}
            </p>

            <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 8 }}>
              {remaining.length === 0 && (
                <div
                  className="card muted"
                  style={{ padding: 14, fontSize: 13, textAlign: "center" }}
                >
                  All steps complete — this onboarding is done.
                </div>
              )}
              {remaining.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    void completeStep(item.key);
                  }}
                  disabled={saving !== null}
                  className="card"
                  style={{
                    padding: "12px 14px",
                    textAlign: "left",
                    background: "var(--bg-elev)",
                    cursor: saving !== null ? "wait" : "pointer",
                    opacity: saving !== null && saving !== item.key ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <I.arrow size={14} style={{ color: "var(--green)", flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--silver-50)" }}>
                        {item.label}
                      </div>
                      <div
                        className="muted"
                        style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.5 }}
                      >
                        {saving === item.key ? "Completing…" : item.description}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {error && (
              <div
                className="card"
                style={{
                  marginTop: 14,
                  padding: "10px 14px",
                  borderColor: "rgba(242,107,92,0.3)",
                  background: "rgba(242,107,92,0.06)",
                  color: "var(--danger)",
                }}
              >
                <span className="mono" style={{ fontSize: 11.5 }}>
                  ERR · {error}
                </span>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
