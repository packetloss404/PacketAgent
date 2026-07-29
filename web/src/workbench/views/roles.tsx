import { useMemo, useState } from "react";
import { I } from "../icons";
import { PanelHeader } from "../Shell";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";

interface RoleSpec {
  id: string;
  name: string;
  system: boolean;
  grants: string[];
}

interface Permission {
  key: string;
  label: string;
  group: string;
}

const PERMISSIONS: Permission[] = [
  { key: "workspace.read", label: "View workspace", group: "Workspace" },
  { key: "workspace.update", label: "Update workspace settings", group: "Workspace" },
  { key: "members.invite", label: "Invite members", group: "Workspace" },
  { key: "members.remove", label: "Remove members", group: "Workspace" },
  { key: "agents.create", label: "Create agents", group: "Build" },
  { key: "agents.edit", label: "Edit agents", group: "Build" },
  { key: "apps.publish", label: "Publish apps", group: "Build" },
  { key: "runs.execute", label: "Execute runs", group: "Run" },
  { key: "runs.cancel", label: "Cancel runs", group: "Run" },
  { key: "providers.configure", label: "Configure providers", group: "Admin" },
  { key: "secrets.read", label: "Reveal secrets", group: "Admin" },
  { key: "secrets.rotate", label: "Rotate secrets", group: "Admin" },
  { key: "audit.export", label: "Export audit log", group: "Admin" },
];

const ROLE_TEMPLATES: RoleSpec[] = [
  { id: "owner", name: "Owner", system: true, grants: ["*"] },
  {
    id: "admin",
    name: "Admin",
    system: true,
    grants: [
      "workspace.read",
      "workspace.update",
      "members.invite",
      "members.remove",
      "agents.create",
      "agents.edit",
      "apps.publish",
      "runs.execute",
      "runs.cancel",
      "providers.configure",
      "secrets.rotate",
      "audit.export",
    ],
  },
  {
    id: "member",
    name: "Member",
    system: true,
    grants: ["workspace.read", "agents.create", "agents.edit", "runs.execute", "runs.cancel"],
  },
  { id: "viewer", name: "Viewer", system: true, grants: ["workspace.read"] },
];

export function RolesView() {
  const [selected, setSelected] = useState<string>("admin");
  const members = useApiData(() => api.listWorkspaceMembers(), []);
  const role = ROLE_TEMPLATES.find((r) => r.id === selected) ?? ROLE_TEMPLATES[0]!;

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const x of members.data?.members ?? []) {
      m[x.role] = (m[x.role] ?? 0) + 1;
    }
    return m;
  }, [members.data]);

  const permGroups = useMemo<Record<string, Permission[]>>(() => {
    const groups: Record<string, Permission[]> = {};
    PERMISSIONS.forEach((p) => {
      (groups[p.group] = groups[p.group] || []).push(p);
    });
    return groups;
  }, []);

  const has = (key: string) => role.grants.includes("*") || role.grants.includes(key);

  return (
    <div style={{ padding: "26px 28px 60px", maxWidth: 1180 }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
        {ROLE_TEMPLATES.length} roles · {PERMISSIONS.length} permissions · enforced server-side on
        every request.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16 }}>
        <div className="card" style={{ overflow: "hidden", alignSelf: "start" }}>
          <PanelHeader title="Roles" />
          {ROLE_TEMPLATES.map((r) => (
            <button
              type="button"
              key={r.id}
              onClick={() => setSelected(r.id)}
              aria-pressed={selected === r.id}
              style={{
                width: "100%",
                padding: "11px 14px",
                border: 0,
                borderTop: "1px solid var(--line)",
                cursor: "pointer",
                color: "inherit",
                textAlign: "left",
                background: selected === r.id ? "var(--bg-elev)" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--silver-50)" }}>
                  {r.name}
                </div>
                {r.system && (
                  <span className="pill muted" style={{ fontSize: 9.5 }}>
                    system
                  </span>
                )}
                <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>
                  {counts[r.id] ?? 0}
                </span>
              </div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
                {r.grants.includes("*") ? "all permissions" : `${r.grants.length} grants`}
              </div>
            </button>
          ))}
        </div>

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1px solid var(--line)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div>
              <div className="h3" style={{ fontSize: 15 }}>
                {role.name}
              </div>
              <div className="mono muted" style={{ fontSize: 11.5 }}>
                {role.id} · {counts[role.id] ?? 0} member{(counts[role.id] ?? 0) === 1 ? "" : "s"}
              </div>
            </div>
            <div className="pill muted" style={{ marginLeft: "auto" }}>
              system managed
            </div>
          </div>

          {Object.entries(permGroups).map(([group, perms]) => (
            <div key={group} style={{ borderTop: "1px solid var(--line)" }}>
              <div className="kicker" style={{ padding: "12px 18px 4px" }}>
                {group}
              </div>
              {perms.map((p) => (
                <div
                  key={p.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "9px 18px",
                    gap: 10,
                    borderTop: "1px solid var(--line)",
                  }}
                >
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      border: `1px solid ${has(p.key) ? "var(--green)" : "var(--line-2)"}`,
                      background: has(p.key) ? "var(--green)" : "transparent",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    {has(p.key) && <I.check size={11} stroke="var(--bg)" />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "var(--silver-50)" }}>{p.label}</div>
                    <div className="mono muted" style={{ fontSize: 11 }}>
                      {p.key}
                    </div>
                  </div>
                  {role.grants.includes("*") && (
                    <span className="pill good" style={{ fontSize: 9.5 }}>
                      granted via wildcard
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
