import { useEffect, useMemo, type ComponentType } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ActivationView } from "./activation";
import { BillingView } from "./billing";
import { IntegrationsView } from "./integrations";
import { NotificationsView } from "./notifications";
import { OperationsView } from "./operations";
import { RateLimitsView } from "./rate-limits";
import { RolesView } from "./roles";
import { SandboxView } from "./sandbox";
import { SecretsView } from "./secrets";
import { SSOView } from "./sso";
import { WebhooksView } from "./webhooks";
import { WorkflowsView } from "./workflows";

interface AdminTab {
  id: string;
  label: string;
  Component: ComponentType;
}

const ADMIN_TABS: AdminTab[] = [
  { id: "roles", label: "Roles", Component: RolesView },
  { id: "sso", label: "SSO & auth", Component: SSOView },
  { id: "secrets", label: "Secrets vault", Component: SecretsView },
  { id: "rate-limits", label: "Rate limits", Component: RateLimitsView },
  { id: "webhooks", label: "Webhooks", Component: WebhooksView },
  { id: "notifications", label: "Notifications", Component: NotificationsView },
  { id: "operations", label: "Operations", Component: OperationsView },
  { id: "integrations", label: "Integrations", Component: IntegrationsView },
  { id: "activation", label: "Activation", Component: ActivationView },
  { id: "sandbox", label: "Sandbox", Component: SandboxView },
  { id: "workflows", label: "Workflows", Component: WorkflowsView },
  { id: "billing", label: "Billing", Component: BillingView },
];

const DEFAULT_TAB_ID = "roles";

export function AdminPage() {
  const navigate = useNavigate();
  const { tab } = useParams<{ tab?: string }>();

  const activeTab = useMemo(() => {
    return ADMIN_TABS.find((t) => t.id === tab) ?? ADMIN_TABS[0];
  }, [tab]);

  useEffect(() => {
    if (!tab || !ADMIN_TABS.some((t) => t.id === tab)) {
      navigate(`/admin/${DEFAULT_TAB_ID}`, { replace: true });
    }
  }, [tab, navigate]);

  const ActiveComponent = activeTab.Component;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        role="tablist"
        aria-label="Admin sections"
        style={{
          display: "flex",
          gap: 4,
          padding: "0 16px",
          borderBottom: "1px solid var(--line)",
          height: 48,
          alignItems: "stretch",
          flexShrink: 0,
          overflowX: "auto",
        }}
      >
        {ADMIN_TABS.map((t) => {
          const isActive = t.id === activeTab.id;
          return (
            <button
              type="button"
              key={t.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => navigate(`/admin/${t.id}`)}
              style={{
                padding: "0 14px",
                fontSize: 13,
                color: isActive ? "var(--silver-50)" : "var(--silver-300)",
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${isActive ? "var(--green)" : "transparent"}`,
                whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <ActiveComponent />
      </div>
    </div>
  );
}

export default AdminPage;
