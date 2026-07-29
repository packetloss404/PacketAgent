import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { I } from "@/workbench/icons";
import { brand } from "@/config/brand";

const showSeedAccounts = import.meta.env.DEV && import.meta.env.VITE_SHOW_SEED_ACCOUNTS === "true";

export default function AuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { signIn, signUp } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = searchParams.get("next");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "sign-up") {
        await signUp({ displayName: displayName.trim(), email: email.trim(), password });
      } else {
        await signIn({ email: email.trim(), password });
      }
      navigate(next && next.startsWith("/") ? next : "/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

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
                {brand.tagline}
              </div>
            </div>
          </Link>
          <Link
            to="/"
            className="btn btn-sm"
            style={{ marginLeft: "auto", textDecoration: "none" }}
          >
            ← Back
          </Link>
        </header>

        <main
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "60px 32px",
            display: "grid",
            gridTemplateColumns: "1.4fr 1fr",
            gap: 60,
          }}
        >
          <section>
            <div className="kicker" style={{ marginBottom: 18 }}>
              {mode === "sign-up" ? "§ NEW WORKSPACE" : "§ AUTHENTICATE"}
            </div>
            <h1
              className="h1"
              style={{ fontSize: 52, fontWeight: 400, letterSpacing: "-0.025em", lineHeight: 1.05 }}
            >
              {mode === "sign-up" ? (
                <>
                  Create your{" "}
                  <span className="serif" style={{ color: "var(--green)", fontWeight: 400 }}>
                    workspace
                  </span>
                  .
                </>
              ) : (
                <>
                  Sign back{" "}
                  <span className="serif" style={{ color: "var(--green)", fontWeight: 400 }}>
                    in
                  </span>
                  .
                </>
              )}
            </h1>
            <p
              className="muted"
              style={{ maxWidth: 540, fontSize: 15.5, lineHeight: 1.6, marginTop: 24 }}
            >
              {mode === "sign-up"
                ? "A self-hosted workbench for activation tracking, workflow drafting, and persistent agents — across Anthropic, OpenAI, MiniMax, and Ollama."
                : "Resume your workspace. Pick up briefs, plans, blockers, validation evidence, runs, and agent telemetry where you left them."}
            </p>

            <div
              style={{
                maxWidth: 460,
                marginTop: 36,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <FactRow label="PROVIDERS" value="Anthropic · OpenAI · MiniMax · Ollama" />
              <FactRow label="SECRETS" value="AES-256-GCM at rest · masked on read" />
              <FactRow label="RUNTIME" value="Persistent job queue · cron · SSE stream" />
            </div>
          </section>

          <section style={{ borderLeft: "1px solid var(--line)", paddingLeft: 40 }}>
            <div
              style={{
                display: "flex",
                gap: 2,
                borderBottom: "1px solid var(--line)",
                marginBottom: 22,
              }}
            >
              <Link
                to="/sign-in"
                className={`tab ${mode === "sign-in" ? "active" : ""}`}
                style={{ textDecoration: "none" }}
              >
                Sign in
              </Link>
              <Link
                to="/sign-up"
                className={`tab ${mode === "sign-up" ? "active" : ""}`}
                style={{ textDecoration: "none" }}
              >
                Create
              </Link>
            </div>

            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {mode === "sign-up" && (
                <label>
                  <span className="label">Display name</span>
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="field"
                    placeholder="New Owner"
                    required
                  />
                </label>
              )}

              <label>
                <span className="label">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="field"
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </label>

              <label>
                <span className="label">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="field"
                  placeholder="••••••••"
                  autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                  required
                />
              </label>

              {error && (
                <div
                  className="card"
                  style={{
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

              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: "100%", justifyContent: "center", marginTop: 6 }}
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <span className="spin">
                      <I.refresh size={13} />
                    </span>{" "}
                    {mode === "sign-up" ? "Creating…" : "Authenticating…"}
                  </>
                ) : (
                  <>
                    <I.arrowUp size={13} /> {mode === "sign-up" ? "Create account" : "Sign in"}
                  </>
                )}
              </button>
            </form>

            {showSeedAccounts && (
              <details
                className="card mono"
                style={{
                  marginTop: 18,
                  padding: "10px 14px",
                  fontSize: 11,
                  color: "var(--silver-400)",
                }}
              >
                <summary style={{ cursor: "pointer", color: "var(--silver-200)" }}>
                  DEV SEED ACCOUNTS
                </summary>
                <p style={{ marginTop: 8, lineHeight: 1.6 }}>
                  <code>alpha@packetagent.local</code>, <code>beta@packetagent.local</code>,{" "}
                  <code>gamma@packetagent.local</code> · password <code>demo12345</code>
                </p>
              </details>
            )}
          </section>
        </main>

        <footer
          style={{
            borderTop: "1px solid var(--line)",
            padding: "20px 32px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            maxWidth: 1100,
            margin: "0 auto",
          }}
        >
          <span className="mono muted" style={{ fontSize: 11 }}>
            © PacketAgent · v0.1.0
          </span>
          <span className="mono muted" style={{ fontSize: 11, marginLeft: "auto" }}>
            self-hosted · MIT
          </span>
        </footer>
      </div>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--line)",
        paddingTop: 10,
        fontSize: 11.5,
        fontFamily: "var(--font-mono)",
        color: "var(--silver-400)",
      }}
    >
      <span style={{ color: "var(--silver-200)" }}>{label}</span>
      {" · "}
      {value}
    </div>
  );
}
