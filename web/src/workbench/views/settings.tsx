import { advancedEntryCount } from "./settings/advanced";
import { AdvancedTab, AuditTab } from "./settings/activity";
import { KeysTab, WorkspaceTab } from "./settings/credentials";
import { MembersTab, InvitesTab, SharesTab } from "./settings/access";
import { Topbar } from "../Shell";
import { api } from "@/lib/api";
import { canManageWorkspaceRole } from "@/lib/roles";
import { useApiData } from "../useApiData";
import { useState } from "react";
import { useWorkbench } from "../workbench-state";

type Tab = "members" | "invitations" | "shares" | "keys" | "workspace" | "audit" | "advanced";

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("members");
  const workspace = useWorkbench().session.workspace;
  const role = workspace.role;
  const canManageWorkspace = canManageWorkspaceRole(role);
  const workspaceFormKey = [
    workspace.id,
    workspace.name,
    workspace.website,
    workspace.automationGoal,
  ].join("\u0000");
  const members = useApiData(() => api.listWorkspaceMembers(), []);
  const apiKeys = useApiData(() => api.listApiKeys(), []);
  const shares = useApiData(() => api.listShareTokens(), []);
  const activity = useApiData(() => api.listActivity(), []);

  const memberCount = members.data?.members.length ?? 0;
  const inviteCount = members.data?.invitations.length ?? 0;
  const shareCount = shares.data?.length ?? 0;
  const keyCount = apiKeys.data?.length ?? 0;

  return (
    <>
      <Topbar crumbs={["__WS__", "Settings"]} />
      <div className="tabbar">
        {(
          [
            { id: "members", label: "Members", count: memberCount },
            { id: "invitations", label: "Invitations", count: inviteCount },
            { id: "shares", label: "Share tokens", count: shareCount },
            { id: "keys", label: "API keys", count: keyCount },
            { id: "workspace", label: "Workspace" },
            { id: "audit", label: "Audit log" },
            { id: "advanced", label: "Advanced", count: advancedEntryCount(canManageWorkspace) },
          ] as const
        ).map((t) => (
          <button
            type="button"
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id as Tab)}
            aria-pressed={tab === t.id}
          >
            {t.label}
            {"count" in t && t.count !== undefined && (
              <span className="mono muted" style={{ fontSize: 10.5, marginLeft: 6 }}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div style={{ padding: "26px 28px", maxWidth: 1080 }}>
        {tab === "members" && (
          <MembersTab
            data={members.data}
            loading={members.loading}
            refresh={members.refresh}
            canManageWorkspace={canManageWorkspace}
          />
        )}
        {tab === "invitations" && (
          <InvitesTab
            data={members.data}
            loading={members.loading}
            refresh={members.refresh}
            canManageWorkspace={canManageWorkspace}
          />
        )}
        {tab === "shares" && (
          <SharesTab
            data={shares.data}
            loading={shares.loading}
            refresh={shares.refresh}
            canManageWorkspace={canManageWorkspace}
          />
        )}
        {tab === "keys" && (
          <KeysTab
            data={apiKeys.data}
            loading={apiKeys.loading}
            refresh={apiKeys.refresh}
            canManageWorkspace={canManageWorkspace}
          />
        )}
        {tab === "workspace" && <WorkspaceTab key={workspaceFormKey} />}
        {tab === "audit" && <AuditTab data={activity.data} loading={activity.loading} />}
        {tab === "advanced" && <AdvancedTab canManageWorkspace={canManageWorkspace} />}
      </div>
    </>
  );
}
