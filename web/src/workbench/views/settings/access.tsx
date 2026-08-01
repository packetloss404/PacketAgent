import { I } from "../../icons";
import { api } from "@/lib/api";

export function MembersTab({
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

export function InvitesTab({
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

export function SharesTab({
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
