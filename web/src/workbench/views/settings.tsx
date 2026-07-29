import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { I, type IconKey } from "../icons";
import { Topbar } from "../Shell";
import { useApiData } from "../useApiData";
import { useWorkbench } from "../workbench-state";
import { api } from "@/lib/api";
import { canManageWorkspaceRole } from "@/lib/roles";

type Tab = "members" | "invitations" | "shares" | "keys" | "workspace" | "audit" | "advanced";

type AdvancedEntry = {
  label: string;
  path: string;
  icon: IconKey;
  owner: "Workspace" | "Admin";
  description: string;
};

const ADVANCED_GROUPS: Array<{ title: string; note: string; entries: AdvancedEntry[] }> = [
  {
    title: "Run Control",
    note: "Operational views for diagnosing, testing, and tuning live workspaces.",
    entries: [
      {
        label: "Operations",
        path: "/operations",
        icon: "pulse",
        owner: "Workspace",
        description: "Health, alerts, and background job metrics.",
      },
      {
        label: "Sandbox",
        path: "/sandbox",
        icon: "cpu",
        owner: "Workspace",
        description: "Inspect and run isolated command executions.",
      },
      {
        label: "Activation",
        path: "/activation",
        icon: "rocket",
        owner: "Workspace",
        description: "Track builder adoption and usage signals.",
      },
      {
        label: "Rate limits",
        path: "/rate-limits",
        icon: "gauge",
        owner: "Admin",
        description: "Provider quotas, throttles, and usage limits.",
      },
    ],
  },
  {
    title: "Access And Trust",
    note: "Admin-only controls for people, authentication, and sensitive credentials.",
    entries: [
      {
        label: "Billing",
        path: "/billing",
        icon: "card",
        owner: "Admin",
        description: "Plan status, seats, and payment records.",
      },
      {
        label: "Roles",
        path: "/roles",
        icon: "shield",
        owner: "Admin",
        description: "Workspace permissions and grant bundles.",
      },
      {
        label: "SSO",
        path: "/sso",
        icon: "lock",
        owner: "Admin",
        description: "Single sign-on and authentication policy.",
      },
      {
        label: "Secrets",
        path: "/secrets",
        icon: "vault",
        owner: "Admin",
        description: "Credential storage, rotation, and access state.",
      },
    ],
  },
  {
    title: "Platform Plumbing",
    note: "Advanced admin tools that usually sit behind the builder workflow.",
    entries: [
      {
        label: "Webhooks",
        path: "/webhooks",
        icon: "webhook",
        owner: "Admin",
        description: "Outbound events, retry state, and signing keys.",
      },
      {
        label: "Notifications",
        path: "/notifications",
        icon: "bell",
        owner: "Admin",
        description: "Email, inbox, and alert delivery settings.",
      },
    ],
  },
];

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

function MembersTab({
  data,
  loading,
  refresh,
  canManageWorkspace,
}: {
  data: {
    members: ReadonlyArray<{
      userId: string;
      email: string;
      displayName: string;
      role: string;
      joinedAt: string;
    }>;
  } | null;
  loading: boolean;
  refresh: () => Promise<void>;
  canManageWorkspace: boolean;
}) {
  const list = data?.members ?? [];
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 14 }}>
        <h1 className="h1" style={{ fontSize: 24 }}>
          Members
        </h1>
        <span className="muted" style={{ marginLeft: 8 }}>
          · workspace access
        </span>
        <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>
          {canManageWorkspace
            ? "Invite creation is not available in this view yet."
            : "Admin role required to invite members."}
        </span>
      </div>
      {loading && <div className="muted">Loading…</div>}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Member</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.userId}>
                <td style={{ color: "var(--silver-50)", fontWeight: 500 }}>{m.displayName}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {m.email}
                </td>
                <td>
                  <span
                    className={`pill ${m.role === "owner" ? "good" : m.role === "viewer" ? "muted" : "info"}`}
                  >
                    {m.role}
                  </span>
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {new Date(m.joinedAt).toLocaleDateString()}
                </td>
                <td>
                  {canManageWorkspace ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: "3px 8px" }}
                      onClick={async () => {
                        try {
                          await api.removeWorkspaceMember(m.userId);
                          await refresh();
                        } catch (e) {
                          console.error(e);
                        }
                      }}
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="mono muted" style={{ fontSize: 11 }}>
                      Admin only
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {list.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  Just you so far.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvitesTab({
  data,
  loading,
  refresh,
  canManageWorkspace,
}: {
  data: {
    invitations: ReadonlyArray<{
      id: string;
      email: string;
      role: string;
      status: string;
      expiresAt: string;
      tokenPreview?: string;
    }>;
  } | null;
  loading: boolean;
  refresh: () => Promise<void>;
  canManageWorkspace: boolean;
}) {
  const list = data?.invitations ?? [];
  return (
    <div>
      <h1 className="h1" style={{ fontSize: 24, marginBottom: 14 }}>
        Pending invitations
      </h1>
      {loading && <div className="muted">Loading…</div>}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Expires</th>
              <th>Token</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((i) => (
              <tr key={i.id}>
                <td className="mono" style={{ color: "var(--silver-50)" }}>
                  {i.email}
                </td>
                <td>
                  <span className="pill info">{i.role}</span>
                </td>
                <td>
                  <span
                    className={`pill ${i.status === "pending" ? "warn" : i.status === "accepted" ? "good" : "muted"}`}
                  >
                    <span className="dot"></span>
                    {i.status}
                  </span>
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {new Date(i.expiresAt).toLocaleDateString()}
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {i.tokenPreview ?? "—"}
                </td>
                <td>
                  {canManageWorkspace ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: "3px 8px" }}
                        onClick={async () => {
                          try {
                            await api.resendWorkspaceInvitation(i.id);
                            await refresh();
                          } catch (e) {
                            console.error(e);
                          }
                        }}
                      >
                        Resend
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: "3px 8px", marginLeft: 4, color: "var(--danger)" }}
                        onClick={async () => {
                          try {
                            await api.revokeWorkspaceInvitation(i.id);
                            await refresh();
                          } catch (e) {
                            console.error(e);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    </>
                  ) : (
                    <span className="mono muted" style={{ fontSize: 11 }}>
                      Admin only
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {list.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No pending invitations.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SharesTab({
  data,
  loading,
  refresh,
  canManageWorkspace,
}: {
  data: ReadonlyArray<{
    id: string;
    scope: string;
    tokenPreview?: string;
    expiresAt?: string;
    createdAt: string;
    revokedAt?: string;
  }> | null;
  loading: boolean;
  refresh: () => Promise<void>;
  canManageWorkspace: boolean;
}) {
  const list = data ?? [];
  return (
    <div>
      <h1 className="h1" style={{ fontSize: 24, marginBottom: 14 }}>
        Share tokens
      </h1>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        Read-only public links for previews and handoffs. Rotate a token to expire old URLs.
      </p>
      {loading && <div className="muted">Loading…</div>}
      {list.map((s) => (
        <div
          key={s.id}
          className="card"
          style={{ padding: 14, marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}
        >
          <I.link size={14} style={{ color: "var(--green)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              scope:{" "}
              <span className="mono" style={{ color: "var(--green)" }}>
                {s.scope}
              </span>
            </div>
            <div className="mono muted" style={{ fontSize: 11 }}>
              created {new Date(s.createdAt).toLocaleDateString()}
              {s.expiresAt
                ? ` · expires ${new Date(s.expiresAt).toLocaleDateString()}`
                : " · no expiry"}
            </div>
          </div>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--silver-400)" }}>
            {s.tokenPreview ?? "—"}
          </span>
          {canManageWorkspace ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{ color: "var(--danger)" }}
              onClick={async () => {
                try {
                  await api.deleteShareToken(s.id);
                  await refresh();
                } catch (e) {
                  console.error(e);
                }
              }}
            >
              Revoke
            </button>
          ) : (
            <span className="mono muted" style={{ fontSize: 11 }}>
              Admin only
            </span>
          )}
        </div>
      ))}
      {list.length === 0 && !loading && (
        <div className="card muted" style={{ padding: 16 }}>
          No share tokens.
        </div>
      )}
    </div>
  );
}

function KeysTab({
  data,
  loading,
  refresh,
  canManageWorkspace,
}: {
  data: ReadonlyArray<{
    id: string;
    provider: string;
    label: string;
    masked: string;
    createdAt: string;
    lastUsedAt?: string;
  }> | null;
  loading: boolean;
  refresh: () => Promise<void>;
  canManageWorkspace: boolean;
}) {
  const list = data ?? [];
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 14 }}>
        <h1 className="h1" style={{ fontSize: 24 }}>
          API keys
        </h1>
        <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>
          {canManageWorkspace
            ? "Key creation is not available in this view yet."
            : "Admin role required to manage API keys."}
        </span>
      </div>
      {loading && <div className="muted">Loading…</div>}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Label</th>
              <th>Provider</th>
              <th>Token</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((k) => (
              <tr key={k.id}>
                <td style={{ color: "var(--silver-50)", fontWeight: 500 }}>{k.label}</td>
                <td>
                  <span className="pill info">{k.provider}</span>
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {k.masked}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {new Date(k.createdAt).toLocaleDateString()}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "—"}
                </td>
                <td>
                  {canManageWorkspace ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: "3px 8px", color: "var(--danger)" }}
                      onClick={async () => {
                        try {
                          await api.deleteApiKey(k.id);
                          await refresh();
                        } catch (e) {
                          console.error(e);
                        }
                      }}
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="mono muted" style={{ fontSize: 11 }}>
                      Admin only
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {list.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No API keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkspaceTab() {
  const session = useWorkbench().session;
  const ws = session.workspace;
  const canManageWorkspace = canManageWorkspaceRole(ws.role);
  const workspaceValues = (workspace: typeof ws) => ({
    name: workspace.name,
    website: workspace.website || "",
    automationGoal: workspace.automationGoal || "",
  });
  const [savedWorkspace, setSavedWorkspace] = useState(() => workspaceValues(ws));
  const [name, setName] = useState(ws.name);
  const [website, setWebsite] = useState(ws.website || "");
  const [goal, setGoal] = useState(ws.automationGoal || "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty =
    name !== savedWorkspace.name ||
    website !== savedWorkspace.website ||
    goal !== savedWorkspace.automationGoal;

  const save = async () => {
    if (!canManageWorkspace || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateWorkspace({ name, website, automationGoal: goal });
      const next = workspaceValues(updated);
      setSavedWorkspace(next);
      setName(next.name);
      setWebsite(next.website);
      setGoal(next.automationGoal);
      setSavedAt(Date.now());
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="h1" style={{ fontSize: 24, marginBottom: 14 }}>
        Workspace
      </h1>
      {!canManageWorkspace && (
        <div
          className="card"
          style={{ padding: "10px 14px", marginBottom: 14, borderColor: "var(--line-2)" }}
        >
          <span className="mono muted" style={{ fontSize: 11 }}>
            Admin role required to update workspace settings.
          </span>
        </div>
      )}
      {error && (
        <div
          className="card"
          style={{
            padding: "10px 14px",
            marginBottom: 14,
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
      <div className="card" style={{ padding: 20 }}>
        <div style={{ marginBottom: 18 }}>
          <label className="label">Name</label>
          <input
            className="field"
            value={name}
            disabled={!canManageWorkspace}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label className="label">Slug</label>
          <input className="field mono" value={ws.slug} readOnly />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label className="label">Website</label>
          <input
            className="field"
            value={website}
            disabled={!canManageWorkspace}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label className="label">Builder goal</label>
          <textarea
            className="field"
            value={goal}
            disabled={!canManageWorkspace}
            onChange={(e) => setGoal(e.target.value)}
          />
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            paddingTop: 14,
            borderTop: "1px solid var(--line)",
            alignItems: "center",
          }}
        >
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void save();
            }}
            disabled={saving || !canManageWorkspace || !dirty}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {dirty && (
            <span className="mono muted" style={{ fontSize: 11 }}>
              Unsaved changes
            </span>
          )}
          {!dirty && savedAt && (
            <span className="mono muted" style={{ fontSize: 11 }}>
              Saved · {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AuditTab({
  data,
  loading,
}: {
  data: ReadonlyArray<{
    id: string;
    event: string;
    scope: string;
    occurredAt: string;
    actor: { type: string; displayName?: string };
    data: Record<string, unknown>;
  }> | null;
  loading: boolean;
}) {
  const list = data ?? [];
  return (
    <div>
      <h1 className="h1" style={{ fontSize: 24, marginBottom: 14 }}>
        Audit log
      </h1>
      {loading && <div className="muted">Loading…</div>}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Scope</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td className="mono muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                  {new Date(a.occurredAt).toLocaleString()}
                </td>
                <td className="mono" style={{ color: "var(--green)", fontSize: 11.5 }}>
                  {a.event}
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {a.actor.displayName ?? a.actor.type}
                </td>
                <td>
                  <span className="pill muted">{a.scope}</span>
                </td>
                <td style={{ fontSize: 12.5 }}>{summarizeData(a.data)}</td>
              </tr>
            ))}
            {list.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No audit entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdvancedTab({ canManageWorkspace }: { canManageWorkspace: boolean }) {
  const navigate = useNavigate();
  const groups = ADVANCED_GROUPS.map((group) => ({
    ...group,
    entries: group.entries.filter((entry) => canManageWorkspace || entry.owner !== "Admin"),
  })).filter((group) => group.entries.length > 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <div className="kicker">ADVANCED</div>
          <h1 className="h1" style={{ fontSize: 24, marginTop: 4 }}>
            {canManageWorkspace ? "Admin and operations tools" : "Operations tools"}
          </h1>
          <p
            className="muted"
            style={{ fontSize: 13, marginTop: 8, marginBottom: 0, maxWidth: 650 }}
          >
            {canManageWorkspace
              ? "These views are available when a workspace needs deeper control. Builders can stay focused on apps, agents, and runs until one of these tools is needed."
              : "Admin-only settings are hidden for your role. Workspace operations views remain available for day-to-day diagnostics."}
          </p>
        </div>
        <span className="pill warn" style={{ marginTop: 3 }}>
          ADVANCED
        </span>
      </div>

      <div style={{ display: "grid", gap: 18 }}>
        {groups.map((group) => (
          <section key={group.title}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
              <h2 className="h3" style={{ fontSize: 14 }}>
                {group.title}
              </h2>
              <span className="muted" style={{ fontSize: 12 }}>
                {group.note}
              </span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
                gap: 10,
              }}
            >
              {group.entries.map((entry) => (
                <AdvancedEntryCard
                  key={entry.path}
                  entry={entry}
                  onOpen={() => navigate(entry.path)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function advancedEntryCount(canManageWorkspace: boolean): number {
  return ADVANCED_GROUPS.reduce(
    (sum, group) =>
      sum + group.entries.filter((entry) => canManageWorkspace || entry.owner !== "Admin").length,
    0,
  );
}

function AdvancedEntryCard({ entry, onOpen }: { entry: AdvancedEntry; onOpen: () => void }) {
  const EntryIcon = I[entry.icon];

  return (
    <button
      type="button"
      className="card"
      onClick={onOpen}
      style={{
        width: "100%",
        minHeight: 126,
        padding: 14,
        textAlign: "left",
        color: "inherit",
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            border: "1px solid var(--line-2)",
            background: "var(--bg-elev)",
            display: "grid",
            placeItems: "center",
            color: "var(--green)",
            flexShrink: 0,
          }}
        >
          <EntryIcon size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--silver-50)" }}>
            {entry.label}
          </div>
          <div className="mono muted" style={{ fontSize: 10.5 }}>
            {entry.owner} tool
          </div>
        </div>
        <I.chevRight size={14} style={{ color: "var(--silver-400)" }} />
      </div>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        {entry.description}
      </div>
      <div className="mono" style={{ marginTop: "auto", fontSize: 11, color: "var(--silver-300)" }}>
        {entry.path}
      </div>
    </button>
  );
}

function summarizeData(data: Record<string, unknown>): string {
  const keys = Object.keys(data ?? {});
  if (keys.length === 0) return "—";
  const first = keys[0]!;
  const val = data[first];
  return `${first}: ${typeof val === "object" ? JSON.stringify(val).slice(0, 60) : String(val).slice(0, 60)}`;
}
