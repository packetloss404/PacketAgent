import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { I } from "../icons";
import { Topbar } from "../Shell";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";
import type { AgentRecord, GeneratedAppSummary } from "@/lib/types";

const EMPTY_AGENTS: AgentRecord[] = [];
const EMPTY_APPS: GeneratedAppSummary[] = [];

export function AgentsView() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"projects" | "templates">("projects");

  return (
    <>
      <Topbar
        crumbs={["__WS__", "Projects"]}
        actions={
          <button
            type="button"
            className="top-btn"
            style={{
              background: "var(--green)",
              color: "#0E1A02",
              borderColor: "var(--green)",
              fontWeight: 600,
            }}
            onClick={() => navigate("/builder")}
          >
            <I.plus size={13} /> New build
          </button>
        }
      />

      <div className="tabbar">
        {(
          [
            { id: "projects", label: "Projects" },
            { id: "templates", label: "Agent templates" },
          ] as const
        ).map((t) => (
          <button
            type="button"
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "projects" && <ProjectsCatalog onOpenAgent={(a) => navigate(`/agents/${a.id}`)} />}
      {tab === "templates" && <AgentTemplates onCreated={(a) => navigate(`/agents/${a.id}`)} />}
    </>
  );
}

function ProjectsCatalog({ onOpenAgent }: { onOpenAgent: (a: AgentRecord) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const agents = useApiData(() => api.listAgents(), []);
  const apps = useApiData(() => api.listGeneratedApps(), []);
  const runs = useApiData(() => api.listAgentRuns(), []);
  const [currentTime] = useState(Date.now);

  const agentList = agents.data ?? EMPTY_AGENTS;
  const appList = apps.data ?? EMPTY_APPS;
  const q = query.trim().toLowerCase();
  const filteredApps = useMemo(
    () =>
      q
        ? appList.filter((app) =>
            `${app.name} ${app.slug} ${app.status} ${app.publishStatus ?? ""}`
              .toLowerCase()
              .includes(q),
          )
        : appList,
    [appList, q],
  );
  const filteredAgents = useMemo(
    () =>
      q
        ? agentList.filter((a) =>
            `${a.name} ${a.id} ${a.description ?? ""} ${a.model ?? ""} ${a.status}`
              .toLowerCase()
              .includes(q),
          )
        : agentList,
    [agentList, q],
  );

  const runs7dByAgent: Record<string, { total: number; success: number }> = {};
  for (const r of runs.data ?? []) {
    if (!r.agentId || !r.startedAt) continue;
    if (currentTime - new Date(r.startedAt).getTime() > 7 * 24 * 60 * 60 * 1000) continue;
    const cur = runs7dByAgent[r.agentId] ?? { total: 0, success: 0 };
    cur.total += 1;
    if (r.status === "success") cur.success += 1;
    runs7dByAgent[r.agentId] = cur;
  }

  const activeAgents = agentList.filter((a) => a.status === "active").length;
  const publishedApps = appList.filter(
    (a) => a.publishStatus === "published" || Boolean(a.publishedUrl),
  ).length;
  const loading = agents.loading || apps.loading;
  const error = agents.error ?? apps.error;

  const refresh = () => {
    void agents.refresh();
    void apps.refresh();
    void runs.refresh();
  };

  const openApp = (app: GeneratedAppSummary) => {
    const isPublished = app.publishStatus === "published" || Boolean(app.publishedUrl);
    const target = isPublished
      ? (app.publishedUrl ?? app.previewUrl)
      : (app.previewUrl ?? app.publishedUrl);
    if (!target) {
      navigate("/builder");
      return;
    }
    if (/^https?:\/\//i.test(target)) {
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }
    navigate(target.startsWith("/") ? target : `/${target}`);
  };

  return (
    <div style={{ padding: "26px 28px" }}>
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <div className="kicker">PROJECTS · {appList.length + agentList.length} TOTAL</div>
          <h1 className="h1" style={{ fontSize: 28, marginTop: 4 }}>
            Apps and agents
          </h1>
          <p className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            {publishedApps} published apps · {activeAgents} active agents
          </p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <input
            className="field"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            style={{ width: 240 }}
          />
          <button type="button" className="btn btn-sm" onClick={refresh}>
            <I.refresh size={12} /> Refresh
          </button>
        </div>
      </div>

      {loading && (
        <div className="muted" style={{ padding: 16 }}>
          Loading projects…
        </div>
      )}
      {error && (
        <div className="card" style={{ padding: 16, color: "var(--danger)" }}>
          {error}
        </div>
      )}
      {!loading && !error && filteredApps.length === 0 && filteredAgents.length === 0 && (
        <div className="card" style={{ padding: 22, textAlign: "center" }}>
          <div className="h3" style={{ fontSize: 15, marginBottom: 6 }}>
            No projects yet
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Describe an app or agent in the builder to create the first one.
          </p>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: 10 }}
            onClick={() => navigate("/builder")}
          >
            Open builder <I.arrow size={11} />
          </button>
        </div>
      )}

      {filteredApps.length > 0 && (
        <>
          <SectionHeading label="Generated apps" count={filteredApps.length} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            {filteredApps.map((app) => (
              <GeneratedAppCard key={app.id} app={app} onOpen={() => openApp(app)} />
            ))}
          </div>
        </>
      )}

      {filteredAgents.length > 0 && (
        <>
          <SectionHeading label="Agents" count={filteredAgents.length} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            {filteredAgents.map((a) => {
              const stats = runs7dByAgent[a.id] ?? { total: 0, success: 0 };
              const successRate = stats.total > 0 ? stats.success / stats.total : 0;
              return (
                <button
                  type="button"
                  key={a.id}
                  className="card project-card-button"
                  style={{ padding: 16, cursor: "pointer" }}
                  onClick={() => onOpenAgent(a)}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <ProjectIcon tone={a.status === "active" ? "good" : "muted"} icon="bot" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--silver-50)" }}>
                        {a.name}
                      </div>
                      <div className="mono muted" style={{ fontSize: 11 }}>
                        {a.id} · {a.provider?.name ?? "No provider"} ·{" "}
                        {a.model ?? a.provider?.defaultModel ?? "No model"}
                      </div>
                    </div>
                    <span
                      className={`pill ${a.status === "active" ? "good" : a.status === "paused" ? "warn" : "muted"}`}
                    >
                      <span className="dot"></span>
                      {a.status}
                    </span>
                  </div>
                  <p className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
                    {a.description || "No description yet."}
                  </p>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11.5 }}
                    className="mono"
                  >
                    <span style={{ color: "var(--silver-300)" }}>
                      <I.zap size={11} style={{ verticalAlign: "-2px" }} />{" "}
                      {a.triggerKind ?? "manual"}
                      {a.schedule ? ` · ${a.schedule}` : ""}
                    </span>
                    <span style={{ color: "var(--silver-400)" }}>
                      {a.enabledTools?.length ?? a.tools?.length ?? 0} tools
                    </span>
                    <span style={{ color: "var(--silver-400)" }}>{stats.total} runs · 7d</span>
                    {stats.total > 0 && (
                      <span
                        style={{
                          color:
                            successRate >= 0.9
                              ? "var(--green)"
                              : successRate >= 0.7
                                ? "var(--warn)"
                                : "var(--silver-400)",
                        }}
                      >
                        {(successRate * 100).toFixed(0)}% success
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "22px 0 10px" }}>
      <div className="kicker">{label}</div>
      <span className="badge">{count}</span>
    </div>
  );
}

function GeneratedAppCard({ app, onOpen }: { app: GeneratedAppSummary; onOpen: () => void }) {
  const published = app.publishStatus === "published" || Boolean(app.publishedUrl);
  return (
    <button
      type="button"
      className="card project-card-button"
      style={{ padding: 16, cursor: "pointer" }}
      onClick={onOpen}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <ProjectIcon tone={published ? "good" : "muted"} icon="layout" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--silver-50)" }}>{app.name}</div>
          <div className="mono muted" style={{ fontSize: 11 }}>
            {app.slug} · {app.id}
          </div>
        </div>
        <span className={`pill ${published ? "good" : app.status === "built" ? "warn" : "muted"}`}>
          <span className="dot"></span>
          {published ? "published" : app.status}
        </span>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
        {published
          ? "Published and ready to share."
          : "Generated app ready for preview, iteration, and publishing."}
      </p>
      <div
        style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11.5 }}
        className="mono"
      >
        <span style={{ color: "var(--silver-300)" }}>
          <I.code size={11} style={{ verticalAlign: "-2px" }} /> app
        </span>
        <span style={{ color: "var(--silver-400)" }}>
          checkpoint {app.checkpointId ?? "pending"}
        </span>
        <span style={{ color: "var(--silver-400)" }}>updated {formatShortDate(app.updatedAt)}</span>
      </div>
    </button>
  );
}

function ProjectIcon({ icon, tone }: { icon: "bot" | "layout"; tone: "good" | "muted" }) {
  const Ico = icon === "bot" ? I.bot : I.layout;
  return (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        background: "var(--bg-elev)",
        border: "1px solid var(--line)",
        display: "grid",
        placeItems: "center",
        color: tone === "good" ? "var(--green)" : "var(--silver-400)",
      }}
    >
      <Ico size={15} />
    </div>
  );
}

function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function AgentTemplates({ onCreated }: { onCreated: (a: AgentRecord) => void }) {
  const templates = useApiData(() => api.listAgentTemplates(), []);
  const [creatingTemplateId, setCreatingTemplateId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const createFromTemplate = async (templateId: string) => {
    if (creatingTemplateId) return;
    setCreatingTemplateId(templateId);
    setCreateError(null);
    try {
      const created = await api.createAgentFromTemplate(templateId);
      onCreated(created);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingTemplateId(null);
    }
  };

  return (
    <div style={{ padding: "26px 28px" }}>
      <div className="kicker">TEMPLATES</div>
      <h1 className="h1" style={{ fontSize: 28, marginTop: 4, marginBottom: 16 }}>
        Start from a template
      </h1>
      {templates.loading && <div className="muted">Loading…</div>}
      {templates.error && (
        <div className="card" style={{ padding: 16, color: "var(--danger)" }}>
          {templates.error}
        </div>
      )}
      {createError && (
        <div className="card" style={{ padding: 16, color: "var(--danger)", marginBottom: 12 }}>
          {createError}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {(templates.data ?? []).map((t) => {
          const creating = creatingTemplateId === t.id;
          return (
            <div key={t.id} className="card" style={{ padding: 16 }}>
              <div className="kicker" style={{ color: "var(--green)" }}>
                {t.category.toUpperCase()}
              </div>
              <div className="h3" style={{ fontSize: 15, marginTop: 6 }}>
                {t.name}
              </div>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 4, minHeight: 40 }}>
                {t.summary || t.description}
              </p>
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: 8 }}
                disabled={Boolean(creatingTemplateId)}
                onClick={() => {
                  void createFromTemplate(t.id);
                }}
              >
                {creating ? (
                  <>
                    <span className="spin">
                      <I.refresh size={11} />
                    </span>{" "}
                    Creating…
                  </>
                ) : (
                  <>
                    Use template <I.arrow size={11} />
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
