import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth-state";
import { WorkbenchProvider } from "./WorkbenchContext";
import { LoggedOutView } from "./views/logged-out";

export function BuilderLayout({ children }: { children: ReactNode }) {
  const { session, loading, signIn, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignIn = () => {
    navigate("/sign-in");
  };

  if (loading) {
    return (
      <div className="wb-root">
        <div
          style={{
            height: "100vh",
            display: "grid",
            placeItems: "center",
            color: "var(--silver-300)",
          }}
        >
          Loading workbench…
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="wb-root">
        <LoggedOutView onSignIn={handleSignIn} />
      </div>
    );
  }

  // touch signIn so eslint doesn't complain it's unused; reserved for future inline-auth flow
  void signIn;

  return (
    <div className="wb-root">
      <WorkbenchProvider session={session} signOut={signOut}>
        <div className="builder-root">{children}</div>
      </WorkbenchProvider>
    </div>
  );
}

export default BuilderLayout;
