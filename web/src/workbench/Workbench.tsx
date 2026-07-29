import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth-state";
import { api } from "@/lib/api";
import { Sidebar } from "./Shell";
import { WorkbenchProvider } from "./WorkbenchContext";
import { CommandPaletteProvider } from "./CommandPalette";
import { AgentEditorView } from "./views/agent-editor";
import { RunDeepView } from "./views/run-deep";
import { RunDetailView } from "./views/run-detail";
import { WorkerRunDetailView } from "./views/worker-run-detail";
import { WorkerRunsView } from "./views/worker-runs";
import { useApiData } from "./useApiData";
import { DashboardView } from "./views/dashboard";
import { AgentsView } from "./views/agents";
import { RunsView } from "./views/runs";
import { SettingsView } from "./views/settings";
import { LoggedOutView } from "./views/logged-out";
import { AdminPage } from "./views/admin";

export default function Workbench() {
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
        <CommandPaletteProvider>
          <WorkbenchInner />
        </CommandPaletteProvider>
      </WorkbenchProvider>
    </div>
  );
}

function WorkbenchInner() {
  // Sidebar agent badge from real agent count
  const agents = useApiData(() => api.listAgents(), []);
  const agentBadge = agents.data ? String(agents.data.length) : undefined;

  return (
    <div className="shell">
      <Sidebar agentBadge={agentBadge} />
      <main className="main">
        <div className="view">
          <Routes>
            <Route index element={<Navigate to="builder" replace />} />
            <Route path="dashboard" element={<DashboardView />} />
            <Route path="agents" element={<AgentsView />} />
            <Route path="agents/new" element={<AgentEditorView />} />
            <Route path="agents/:id" element={<AgentEditorView />} />
            <Route path="runs" element={<WorkerRunsView />} />
            <Route path="runs/worker/:id" element={<WorkerRunDetailView />} />
            <Route path="runs/:id" element={<RunDeepView />} />
            <Route path="activity" element={<RunsView />} />
            <Route path="activity/:id" element={<RunDetailView />} />
            <Route path="settings" element={<SettingsView />} />
            <Route path="admin/:tab?" element={<AdminPage />} />
            <Route path="roles" element={<Navigate to="/admin/roles" replace />} />
            <Route path="sso" element={<Navigate to="/admin/sso" replace />} />
            <Route path="secrets" element={<Navigate to="/admin/secrets" replace />} />
            <Route path="rate-limits" element={<Navigate to="/admin/rate-limits" replace />} />
            <Route path="webhooks" element={<Navigate to="/admin/webhooks" replace />} />
            <Route path="notifications" element={<Navigate to="/admin/notifications" replace />} />
            <Route path="operations" element={<Navigate to="/admin/operations" replace />} />
            <Route path="integrations" element={<Navigate to="/admin/integrations" replace />} />
            <Route path="activation" element={<Navigate to="/admin/activation" replace />} />
            <Route path="sandbox" element={<Navigate to="/admin/sandbox" replace />} />
            <Route path="workflows" element={<Navigate to="/admin/workflows" replace />} />
            <Route path="billing" element={<Navigate to="/admin/billing" replace />} />
            <Route path="alerts" element={<Navigate to="/admin/alerts" replace />} />
            <Route path="*" element={<RedirectToBuilder />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function RedirectToBuilder() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/builder", { replace: true });
  }, [navigate]);
  return null;
}
