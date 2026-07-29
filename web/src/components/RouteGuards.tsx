import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/auth-state";

function FullScreenLoader() {
  return (
    <div
      className="wb-root wb-root wb-root"
      style={{
        height: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "0 24px",
      }}
    >
      <div
        className="card"
        style={{ padding: 32, textAlign: "center", width: "100%", maxWidth: 420 }}
      >
        <div className="kicker" style={{ marginBottom: 10 }}>
          LOADING
        </div>
        <h1 className="h2" style={{ fontSize: 18, color: "var(--silver-50)" }}>
          Restoring your workspace
        </h1>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { loading, session } = useAuth();
  const next = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);

  if (loading) return <FullScreenLoader />;
  if (!session) return <Navigate to={`/sign-in?next=${next}`} replace />;
  return <>{children}</>;
}

export function PublicOnly({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { loading, session } = useAuth();
  const search = new URLSearchParams(location.search);
  const requestedNext = search.get("next");

  if (loading) return <FullScreenLoader />;
  if (session) {
    return (
      <Navigate
        to={requestedNext && requestedNext.startsWith("/") ? requestedNext : "/builder"}
        replace
      />
    );
  }
  return <>{children}</>;
}

export function RequireOnboarding({ children }: { children: ReactNode }) {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const next = search.get("next");
  const { loading, session } = useAuth();

  if (loading) return <FullScreenLoader />;
  if (!session) {
    return (
      <Navigate
        to={`/sign-in?next=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}`}
        replace
      />
    );
  }
  if (session.onboarding.completed) {
    return <Navigate to={next && next.startsWith("/") ? next : "/builder"} replace />;
  }
  return <>{children}</>;
}
