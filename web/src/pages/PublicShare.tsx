import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { PublicSharePayload } from "@/lib/types";
import { I } from "@/workbench/icons";
import { brand } from "@/config/brand";

export default function PublicSharePage() {
  const { token } = useParams();
  const [shared, setShared] = useState<PublicSharePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setError("Share token is missing.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .getPublicShare(token)
      .then(setShared)
      .catch((shareError) => setError((shareError as Error).message))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="wb-root wb-root wb-root" style={{ height: "100vh", overflow: "auto" }}>
      <div
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(900px 500px at 50% -10%, rgba(184,242,92,0.06), transparent 60%), var(--bg)",
        }}
      >
        <header
          style={{
            height: 64,
            display: "flex",
            alignItems: "center",
            padding: "0 32px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <Link
            to="/"
            style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}
          >
            <div className="brand-mark" style={{ width: 30, height: 30 }} />
            <div>
              <div className="brand-name" style={{ fontSize: 16 }}>
                {brand.name}
              </div>
              <div className="brand-tag" style={{ fontSize: 9.5 }}>
                PUBLIC SHARE
              </div>
            </div>
          </Link>
          <Link
            to="/sign-in"
            className="btn btn-sm"
            style={{ marginLeft: "auto", textDecoration: "none" }}
          >
            Sign in
          </Link>
        </header>

        <section style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 32px 60px" }}>
          {loading && (
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--silver-400)" }}
            >
              <span className="spin">
                <I.refresh size={14} />
              </span>
              <span className="kicker">LOADING SHARE</span>
            </div>
          )}
          {error && (
            <div
              className="card"
              style={{
                padding: "12px 16px",
                borderColor: "rgba(242,107,92,0.3)",
                background: "rgba(242,107,92,0.06)",
                color: "var(--danger)",
              }}
            >
              <span className="mono" style={{ fontSize: 12 }}>
                ERR · {error}
              </span>
            </div>
          )}
          {!loading && !error && shared && <SharedContent shared={shared} />}
        </section>
      </div>
    </div>
  );
}

function SharedContent({ shared }: { shared: PublicSharePayload }) {
  const showBrief = shared.scope === "brief" || shared.scope === "overview";
  const showPlan = shared.scope === "plan" || shared.scope === "overview";

  return (
    <div>
      <div className="kicker" style={{ marginBottom: 14 }}>
        {shared.scope.toUpperCase()} · SHARED WORKSPACE
      </div>
      <h1
        className="h1"
        style={{ fontSize: 44, fontWeight: 400, letterSpacing: "-0.02em", marginBottom: 14 }}
      >
        {shared.workspace.name}
      </h1>
      {shared.workspace.automationGoal && (
        <p className="muted" style={{ maxWidth: 720, fontSize: 16, lineHeight: 1.6 }}>
          {shared.workspace.automationGoal}
        </p>
      )}

      {showBrief && shared.brief && (
        <section style={{ marginTop: 36 }}>
          <div className="kicker" style={{ marginBottom: 6 }}>
            BRIEF
          </div>
          <h2 className="h2" style={{ fontSize: 24, marginBottom: 14 }}>
            {shared.brief.summary}
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <ShareField label="Audience" value={shared.brief.audience} />
            <ShareField label="Desired outcome" value={shared.brief.desiredOutcome} />
            <ShareField label="Problem" value={shared.brief.problemStatement} />
            <ShareField label="Constraints" value={shared.brief.constraints} />
          </div>
          {shared.brief.goals.length > 0 && <ShareList title="Goals" items={shared.brief.goals} />}
          {shared.brief.successMetrics?.length ? (
            <ShareList title="Success metrics" items={shared.brief.successMetrics} />
          ) : null}
        </section>
      )}

      {showPlan && (
        <section style={{ marginTop: 36 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <div>
              <div className="kicker" style={{ marginBottom: 6 }}>
                PLAN
              </div>
              <h2 className="h2" style={{ fontSize: 24 }}>
                Requirements and implementation plan
              </h2>
            </div>
            <span className="mono muted" style={{ fontSize: 11 }}>
              {shared.planItems?.length ?? 0} ITEMS
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22 }}>
            <div>
              <div className="kicker" style={{ marginBottom: 8 }}>
                REQUIREMENTS
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(shared.requirements ?? []).map((requirement) => (
                  <article key={requirement.id} className="card" style={{ padding: 14 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <h4
                        className="serif"
                        style={{
                          fontFamily: "var(--font-serif)",
                          fontSize: 17,
                          color: "var(--silver-50)",
                          margin: 0,
                        }}
                      >
                        {requirement.title}
                      </h4>
                      <span className="pill muted">{requirement.priority}</span>
                    </div>
                    <p className="muted" style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
                      {requirement.detail}
                    </p>
                  </article>
                ))}
                {(shared.requirements ?? []).length === 0 && (
                  <div
                    className="card muted"
                    style={{ padding: 14, textAlign: "center", fontSize: 12.5 }}
                  >
                    No requirements shared.
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="kicker" style={{ marginBottom: 8 }}>
                PLAN ITEMS
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(shared.planItems ?? []).map((item) => (
                  <article key={item.id} className="card" style={{ padding: 14 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <h4
                        className="serif"
                        style={{
                          fontFamily: "var(--font-serif)",
                          fontSize: 17,
                          color: "var(--silver-50)",
                          margin: 0,
                        }}
                      >
                        {item.title}
                      </h4>
                      <span
                        className={`pill ${item.status === "done" ? "good" : item.status === "in_progress" ? "info" : "muted"}`}
                      >
                        <span className="dot"></span>
                        {item.status}
                      </span>
                    </div>
                    <p className="muted" style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
                      {item.description}
                    </p>
                  </article>
                ))}
                {(shared.planItems ?? []).length === 0 && (
                  <div
                    className="card muted"
                    style={{ padding: 14, textAlign: "center", fontSize: 12.5 }}
                  >
                    No plan items shared.
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function ShareField({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="kicker" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--silver-200)" }}>{value}</div>
    </div>
  );
}

function ShareList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div className="kicker" style={{ marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {items.map((item) => (
          <div
            key={item}
            className="card"
            style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--silver-300)" }}
          >
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
