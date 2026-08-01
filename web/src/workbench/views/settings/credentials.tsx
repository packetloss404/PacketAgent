import { api } from "@/lib/api";
import { canManageWorkspaceRole } from "@/lib/roles";
import { type ApiKeyProviderName } from "@/lib/types";
import { useState } from "react";
import { useWorkbench } from "../../workbench-state";

export function KeysTab({
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
  const [provider, setProvider] = useState<ApiKeyProviderName>("openai");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveKey = async () => {
    if (!canManageWorkspace || !label.trim() || !value) return;
    setSaving(true);
    setError(null);
    try {
      await api.createApiKey({ provider, label: label.trim(), value });
      setLabel("");
      setValue("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 14 }}>
        <h1 className="h1" style={{ fontSize: 24 }}>
          API keys
        </h1>
        <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>
          {canManageWorkspace
            ? "Encrypted at rest; values are never returned after save."
            : "Admin role required to manage API keys."}
        </span>
      </div>
      {canManageWorkspace && (
        <form
          className="card"
          style={{
            display: "grid",
            gridTemplateColumns:
              "minmax(150px, 0.7fr) minmax(180px, 1fr) minmax(240px, 1.5fr) auto",
            gap: 10,
            padding: 14,
            marginBottom: 14,
            alignItems: "end",
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey();
          }}
        >
          <label>
            <span className="label">Provider</span>
            <select
              className="field"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ApiKeyProviderName)}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
              <option value="minimax">MiniMax</option>
              <option value="gemini">Google Gemini</option>
              <option value="ollama">Local endpoint key</option>
            </select>
          </label>
          <label>
            <span className="label">Label</span>
            <input
              className="field"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Default"
              required
            />
          </label>
          <label>
            <span className="label">Key</span>
            <input
              className="field mono"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              placeholder="Paste provider key"
              required
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !label.trim() || !value}
          >
            {saving ? "Saving…" : "Store key"}
          </button>
          {error && (
            <span
              className="mono"
              style={{
                gridColumn: "1 / -1",
                color: "var(--danger)",
                fontSize: 11.5,
              }}
            >
              ERR · {error}
            </span>
          )}
        </form>
      )}
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

export function WorkspaceTab() {
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
