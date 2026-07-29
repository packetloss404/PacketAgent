import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { brand } from "@/config/brand";
import { I } from "../icons";

const VERSION = "v0.1.0";

export function LoggedOutView({ onSignIn: _onSignIn }: { onSignIn: () => void }) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn({ email: email.trim(), password });
      // session state flips → Workbench re-renders into the authenticated UI
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px",
        background:
          "radial-gradient(900px 500px at 50% 20%, rgba(184,242,92,0.07), transparent 60%), var(--bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 14,
          marginBottom: 32,
        }}
      >
        <div className="brand-mark" style={{ width: 56, height: 56, borderRadius: 14 }} />
        <div style={{ textAlign: "center" }}>
          <div className="brand-name" style={{ fontSize: 26, letterSpacing: "-0.02em" }}>
            {brand.name}
          </div>
          <div className="brand-tag" style={{ marginTop: 4 }}>
            {brand.tagline}
          </div>
        </div>
      </div>

      <form
        onSubmit={submit}
        className="card"
        style={{
          width: "100%",
          maxWidth: 380,
          padding: 22,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "0 0 0 1px var(--line), 0 40px 100px -50px rgba(184,242,92,0.18)",
        }}
      >
        <label>
          <span className="label">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field"
            placeholder="you@example.com"
            autoComplete="email"
            autoFocus
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
            autoComplete="current-password"
            required
          />
        </label>

        {error && (
          <div
            style={{
              padding: "9px 12px",
              borderRadius: 8,
              border: "1px solid rgba(242,107,92,0.3)",
              background: "rgba(242,107,92,0.06)",
              color: "var(--danger)",
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
            }}
          >
            ERR · {error}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", marginTop: 4 }}
          disabled={submitting}
        >
          {submitting ? (
            <>
              <span className="spin">
                <I.refresh size={13} />
              </span>{" "}
              Signing in…
            </>
          ) : (
            <>
              <I.arrowUp size={13} /> Sign in
            </>
          )}
        </button>

        <div style={{ textAlign: "center", marginTop: 4 }}>
          <Link
            to="/sign-up"
            className="mono"
            style={{
              color: "var(--silver-400)",
              fontSize: 11.5,
              textDecoration: "none",
              letterSpacing: "0.06em",
            }}
          >
            New here? <span style={{ color: "var(--green)" }}>Create an account</span>
          </Link>
        </div>
      </form>

      <div style={{ marginTop: 28, display: "flex", gap: 14, alignItems: "center" }}>
        <span className="mono muted" style={{ fontSize: 10.5 }}>
          © PacketAgent · {VERSION}
        </span>
        <span className="mono muted" style={{ fontSize: 10.5 }}>
          self-hosted · MIT
        </span>
      </div>
    </div>
  );
}
