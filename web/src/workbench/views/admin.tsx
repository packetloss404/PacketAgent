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
import { AccessibleTabPanel, AccessibleTabs } from "@/components/AccessibleTabs";

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
      <AccessibleTabs
        id="admin"
        label="Admin sections"
        tabs={ADMIN_TABS.map((tabDefinition) => ({
          id: tabDefinition.id,
          label: tabDefinition.label,
        }))}
        activeId={activeTab.id}
        onSelect={(id) => navigate(`/admin/${id}`)}
        className="tabbar admin-tabbar"
      />
      <AccessibleTabPanel id="admin" tabId={activeTab.id} className="admin-tab-panel">
        <ActiveComponent />
      </AccessibleTabPanel>
    </div>
  );
}

export default AdminPage;
