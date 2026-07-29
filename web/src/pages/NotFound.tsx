import { Link, useLocation } from "react-router-dom";
import { useAuth } from "@/context/auth-state";

export default function NotFoundPage() {
  const location = useLocation();
  const { session } = useAuth();
  const home = session ? "/dashboard" : "/";

  return (
    <div className="wb-root wb-root wb-root" style={{ height: "100vh", overflow: "auto" }}>
      <div
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(900px 500px at 50% -10%, rgba(184,242,92,0.06), transparent 60%), var(--bg)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "60px 32px",
        }}
      >
        <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
          <div className="kicker" style={{ marginBottom: 24 }}>
            // HTTP 404 · ROUTE NOT FOUND
          </div>
          <h1
            className="serif"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(6rem, 18vw, 14rem)",
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: "-0.05em",
              color: "var(--silver-50)",
              margin: 0,
            }}
          >
            404.
          </h1>
          <p className="mono" style={{ marginTop: 30, fontSize: 13, color: "var(--silver-400)" }}>
            NO RESOURCE AT <span style={{ color: "var(--green)" }}>{location.pathname}</span>
          </p>
          <p
            style={{
              marginTop: 8,
              maxWidth: 640,
              fontSize: 16,
              lineHeight: 1.6,
              color: "var(--silver-300)",
            }}
          >
            That path doesn{"’"}t resolve to anything in this workspace. The route was either never
            registered or has been removed.
          </p>
          <div style={{ marginTop: 30, display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Link to={home} className="btn btn-primary" style={{ textDecoration: "none" }}>
              ← Back to {session ? "dashboard" : "portal"}
            </Link>
            {session && (
              <Link to="/agents" className="btn btn-sm" style={{ textDecoration: "none" }}>
                Agents
              </Link>
            )}
            {session && (
              <Link to="/workflows" className="btn btn-sm" style={{ textDecoration: "none" }}>
                Workflows
              </Link>
            )}
            {session && (
              <Link to="/runs" className="btn btn-sm" style={{ textDecoration: "none" }}>
                Runs
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
