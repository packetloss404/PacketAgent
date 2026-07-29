import { Fragment, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { I, type IconKey } from "./icons";
import { useUser, useWorkbench, useWorkspaceName } from "./WorkbenchContext";
import { useCommandPalette } from "./CommandPalette";
import { brand } from "@/config/brand";

export type ViewKey =
  | "dashboard"
  | "builder"
  | "agents"
  | "workflows"
  | "runs"
  | "integrations"
  | "operations"
  | "sandbox"
  | "activation"
  | "settings"
  | "billing"
  | "roles"
  | "sso"
  | "secrets"
  | "webhooks"
  | "rate-limits"
  | "notifications"
  | "admin";

type NavSpec = { id: ViewKey; label: string; icon: IconKey; badge?: string; title?: string };

function viewFromPath(pathname: string): ViewKey {
  const m = pathname.match(/^\/?([^/?#]*)/);
  const key = (m?.[1] ?? "") as string;
  if (!key) return "builder";
  return key as ViewKey;
}

export function useActiveView(): ViewKey {
  const { pathname } = useLocation();
  return viewFromPath(pathname);
}

export function Sidebar({ agentBadge }: { agentBadge?: string }) {
  const navigate = useNavigate();
  const active = useActiveView();
  const { signOut } = useWorkbench();
  const user = useUser();
  const workspaceName = useWorkspaceName();
  const role = useWorkbench().session.workspace.role ?? "member";

  const palette = useCommandPalette();

  const setActive = (key: ViewKey) => {
    navigate(`/${key}`);
  };

  const primary: NavSpec[] = [
    {
      id: "builder",
      label: "Build",
      icon: "code",
      badge: "live",
      title: "Create and iterate on apps and agents",
    },
    {
      id: "agents",
      label: "Projects",
      icon: "layout",
      badge: agentBadge,
      title: "Browse generated apps and agents in this workspace",
    },
    { id: "runs", label: "Runs", icon: "activity", title: "See past agent runs" },
    {
      id: "admin",
      label: "Admin",
      icon: "settings",
      title: "Workspace settings, integrations, secrets, billing",
    },
  ];

  const initial = (workspaceName.trim()[0] ?? "W").toUpperCase();
  const userInitials =
    user.displayName
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "U";

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"></div>
        <div>
          <div className="brand-name">{brand.name}</div>
          <div className="brand-tag">{brand.tagline}</div>
        </div>
      </div>

      <div className="ws-switch" title="Current workspace">
        <div className="ws-avatar">{initial}</div>
        <div className="ws-meta">
          <div className="ws-name">{workspaceName}</div>
          <div className="ws-role">{role}</div>
        </div>
        <I.chevDown size={14} className="ws-chev" />
      </div>

      <button
        type="button"
        className="nav-search"
        onClick={() => palette.open()}
        aria-label="Open command palette"
      >
        <I.search size={14} />
        <span>Search…</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="nav-section">
        {primary.map((it) => (
          <NavItem
            key={it.id}
            item={it}
            active={active === it.id}
            onClick={() => setActive(it.id)}
          />
        ))}
      </div>

      <button
        type="button"
        className="sidebar-foot"
        onClick={() => {
          void signOut();
        }}
        title="Sign out"
      >
        <div className="avatar">{userInitials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="user-name">{user.displayName}</div>
          <div className="user-mail">{user.email}</div>
        </div>
        <I.arrow size={14} style={{ color: "var(--silver-400)" }} />
      </button>
    </aside>
  );
}

function NavItem({
  item,
  active,
  onClick,
}: {
  item: NavSpec;
  active: boolean;
  onClick: () => void;
}) {
  const Ico = I[item.icon] || I.home;
  return (
    <button
      type="button"
      className={`nav-item ${active ? "active" : ""}`}
      title={item.title}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <Ico size={15} className="ico" />
      <span>{item.label}</span>
      {item.badge && <span className="badge">{item.badge}</span>}
    </button>
  );
}

export function Topbar({ crumbs, actions }: { crumbs: string[]; actions?: ReactNode }) {
  const workspaceName = useWorkspaceName();
  const navigate = useNavigate();
  const finalCrumbs = crumbs[0] === "__WS__" ? [workspaceName, ...crumbs.slice(1)] : crumbs;
  return (
    <div className="topbar">
      <div className="crumb">
        {finalCrumbs.map((c, i) => (
          <Fragment key={i}>
            <span className={i === finalCrumbs.length - 1 ? "here" : ""}>{c}</span>
            {i < finalCrumbs.length - 1 && <span className="sep">/</span>}
          </Fragment>
        ))}
      </div>
      <div className="topbar-actions">
        <button type="button" className="top-btn" onClick={() => navigate("/admin/operations")}>
          <span className="dot"></span> System status
        </button>
        {actions}
        <button
          type="button"
          className="top-btn"
          onClick={() => navigate("/admin/notifications")}
          aria-label="Open notifications"
          title="Notifications"
        >
          <I.bell size={13} />
        </button>
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "good" | "danger";
}) {
  const color =
    tone === "good" ? "var(--green)" : tone === "danger" ? "var(--danger)" : "var(--silver-50)";
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="kicker">{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
        <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: "-0.02em", color }}>
          {value}
        </div>
      </div>
      {sub !== undefined && (
        <div className="muted mono" style={{ fontSize: 11, marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function PanelHeader({
  title,
  sub,
  action,
}: {
  title: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "12px 16px",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <div>
        <div className="h3" style={{ fontSize: 13.5 }}>
          {title}
        </div>
        {sub && (
          <div className="muted" style={{ fontSize: 11.5 }}>
            {sub}
          </div>
        )}
      </div>
      <div style={{ marginLeft: "auto" }}>{action}</div>
    </div>
  );
}
