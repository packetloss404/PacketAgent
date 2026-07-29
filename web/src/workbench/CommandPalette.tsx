import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { I, type IconKey } from "./icons";
import { CommandPaletteContext } from "./command-palette-state";
import { api } from "@/lib/api";
import type { AgentRecord } from "@/lib/types";

interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group: "Build" | "Projects" | "Runs" | "Settings" | "Advanced";
  keywords: string;
  icon: IconKey;
  perform: () => void | Promise<void>;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((c) => !c), []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (isModifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggle();
      }
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle]);

  const value = useMemo(() => ({ open, close, toggle, isOpen }), [open, close, toggle, isOpen]);
  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {isOpen ? <Palette onClose={close} /> : null}
    </CommandPaletteContext.Provider>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [runningAgentId, setRunningAgentId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let mounted = true;
    api
      .listAgents()
      .then((next) => mounted && setAgents(next))
      .catch(() => mounted && setAgents([]));
    return () => {
      mounted = false;
    };
  }, []);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  const runAgentCommand = async (agentId: string) => {
    setRunningAgentId(agentId);
    try {
      const response = await api.runAgent(agentId);
      if (response.approval) {
        window.alert(
          "Tool access approval required. Open the agent editor to approve tools before running this agent.",
        );
        setRunningAgentId(null);
        return;
      }
      onClose();
      navigate("/runs");
    } catch {
      setRunningAgentId(null);
    }
  };

  const commands = useMemo<PaletteCommand[]>(() => {
    const build: PaletteCommand[] = [
      {
        id: "action-open-builder",
        label: "Open Builder",
        hint: "Default workspace home",
        group: "Build",
        keywords: "builder build app code home",
        icon: "code",
        perform: () => go("/builder"),
      },
      {
        id: "action-new-build",
        label: "Start from prompt",
        hint: "Describe an app or agent",
        group: "Build",
        keywords: "new build prompt app agent",
        icon: "sparkle",
        perform: () => go("/builder"),
      },
      {
        id: "action-new-project",
        label: "New project",
        hint: "Create from the builder",
        group: "Build",
        keywords: "new project agent app create",
        icon: "plus",
        perform: () => go("/builder"),
      },
    ];
    const primary: PaletteCommand[] = [
      {
        id: "nav-projects",
        label: "Projects",
        group: "Projects",
        keywords: "projects agents bot",
        icon: "layout",
        perform: () => go("/agents"),
      },
      {
        id: "nav-runs",
        label: "Runs",
        group: "Runs",
        keywords: "runs activity history",
        icon: "activity",
        perform: () => go("/runs"),
      },
      {
        id: "nav-settings",
        label: "Settings",
        group: "Settings",
        keywords: "settings members keys workspace audit",
        icon: "settings",
        perform: () => go("/settings"),
      },
    ];
    const advanced: PaletteCommand[] = [
      {
        id: "nav-dashboard",
        label: "Dashboard",
        group: "Advanced",
        keywords: "dashboard home",
        icon: "home",
        perform: () => go("/dashboard"),
      },
      {
        id: "nav-workflows",
        label: "Workflows",
        group: "Advanced",
        keywords: "workflows brief plan blockers",
        icon: "flow",
        perform: () => go("/workflows"),
      },
      {
        id: "nav-providers",
        label: "Providers",
        group: "Advanced",
        keywords: "providers integrations llm tools env",
        icon: "key",
        perform: () => go("/integrations"),
      },
      {
        id: "nav-operations",
        label: "Operations",
        group: "Advanced",
        keywords: "operations health alerts jobs",
        icon: "pulse",
        perform: () => go("/operations"),
      },
      {
        id: "nav-sandbox",
        label: "Sandbox",
        group: "Advanced",
        keywords: "sandbox docker exec terminal",
        icon: "cpu",
        perform: () => go("/sandbox"),
      },
      {
        id: "nav-activation",
        label: "Activation",
        group: "Advanced",
        keywords: "activation onboarding",
        icon: "rocket",
        perform: () => go("/activation"),
      },
      {
        id: "nav-billing",
        label: "Billing & plan",
        group: "Advanced",
        keywords: "billing usage spend",
        icon: "card",
        perform: () => go("/billing"),
      },
      {
        id: "nav-roles",
        label: "Roles & permissions",
        group: "Advanced",
        keywords: "roles permissions access",
        icon: "shield",
        perform: () => go("/roles"),
      },
      {
        id: "nav-sso",
        label: "SSO & auth",
        group: "Advanced",
        keywords: "sso saml auth",
        icon: "lock",
        perform: () => go("/sso"),
      },
      {
        id: "nav-secrets",
        label: "Secrets vault",
        group: "Advanced",
        keywords: "secrets vault env",
        icon: "vault",
        perform: () => go("/secrets"),
      },
      {
        id: "nav-webhooks",
        label: "Webhooks",
        group: "Advanced",
        keywords: "webhooks triggers",
        icon: "webhook",
        perform: () => go("/webhooks"),
      },
      {
        id: "nav-rate-limits",
        label: "Rate limits",
        group: "Advanced",
        keywords: "rate limits quota",
        icon: "gauge",
        perform: () => go("/rate-limits"),
      },
      {
        id: "nav-notifications",
        label: "Notifications",
        group: "Advanced",
        keywords: "notifications channels alerts",
        icon: "bell",
        perform: () => go("/notifications"),
      },
    ];
    const agentCommands: PaletteCommand[] = agents.flatMap((a) => [
      {
        id: `open-agent-${a.id}`,
        label: a.name,
        hint: a.description || a.model || "Open project",
        group: "Projects",
        keywords: `open view project agent ${a.name} ${a.id} ${a.description ?? ""} ${a.model ?? ""}`,
        icon: "bot",
        perform: () => go(`/agents/${a.id}`),
      },
      {
        id: `run-agent-${a.id}`,
        label: `Run ${a.name}`,
        hint: a.triggerKind ? `Start ${a.triggerKind} run` : "Start manual run",
        group: "Runs",
        keywords: `run start execute agent ${a.name} ${a.id} ${a.description ?? ""} ${a.model ?? ""}`,
        icon: "play",
        perform: async () => runAgentCommand(a.id),
      },
    ]);
    return [...build, ...primary, ...agentCommands, ...advanced];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const grouped = useMemo(() => {
    const groups: Record<string, PaletteCommand[]> = {};
    for (const c of filtered) {
      (groups[c.group] = groups[c.group] || []).push(c);
    }
    return groups;
  }, [filtered]);

  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const cmd = filtered[activeIndex];
      if (cmd) void cmd.perform();
    }
  };

  return (
    <div
      className="wb-palette-root"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(6, 7, 8, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
    >
      <div
        className="wb-root wb-root wb-root"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel)",
          border: "1px solid var(--line-2)",
          borderRadius: 12,
          width: "min(640px, 92vw)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 30px 80px -20px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--line-2)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 16px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <I.search size={16} style={{ color: "var(--silver-400)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKey}
            placeholder="Search commands, agents, settings…"
            className="field"
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              fontSize: 15,
              color: "var(--silver-50)",
              outline: "none",
            }}
          />
          <kbd
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--silver-300)",
              border: "1px solid var(--line-2)",
              padding: "1px 5px",
              borderRadius: 4,
              background: "var(--ink)",
            }}
          >
            ESC
          </kbd>
        </div>

        <div style={{ overflow: "auto", flex: 1 }}>
          {filtered.length === 0 && (
            <div className="muted" style={{ padding: 22, textAlign: "center", fontSize: 13 }}>
              No commands match.
            </div>
          )}
          {Object.entries(grouped).map(([group, cmds]) => (
            <div key={group}>
              <div
                className="kicker"
                style={{ padding: "10px 16px 6px", color: "var(--silver-500)" }}
              >
                {group}
              </div>
              {cmds.map((cmd) => {
                const idx = filtered.indexOf(cmd);
                const active = idx === activeIndex;
                const Ico = I[cmd.icon] || I.home;
                return (
                  <div
                    key={cmd.id}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => {
                      void cmd.perform();
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 16px",
                      cursor: "pointer",
                      background: active ? "var(--bg-elev)" : "transparent",
                      borderLeft: `2px solid ${active ? "var(--green)" : "transparent"}`,
                    }}
                  >
                    <Ico
                      size={14}
                      style={{
                        color: active ? "var(--green)" : "var(--silver-300)",
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, color: "var(--silver-50)" }}>{cmd.label}</div>
                      {cmd.hint && (
                        <div
                          className="mono muted"
                          style={{
                            fontSize: 11,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {cmd.hint}
                        </div>
                      )}
                    </div>
                    {cmd.id === `run-agent-${runningAgentId}` && (
                      <span className="spin">
                        <I.refresh size={12} />
                      </span>
                    )}
                    {active && (
                      <span className="mono muted" style={{ fontSize: 10 }}>
                        ↵
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            gap: 14,
            padding: "10px 16px",
            borderTop: "1px solid var(--line)",
            fontSize: 11,
          }}
          className="mono muted"
        >
          <span>
            <kbd
              style={{
                fontFamily: "var(--font-mono)",
                border: "1px solid var(--line-2)",
                padding: "1px 5px",
                borderRadius: 4,
                background: "var(--ink)",
              }}
            >
              ↑↓
            </kbd>{" "}
            Navigate
          </span>
          <span>
            <kbd
              style={{
                fontFamily: "var(--font-mono)",
                border: "1px solid var(--line-2)",
                padding: "1px 5px",
                borderRadius: 4,
                background: "var(--ink)",
              }}
            >
              ↵
            </kbd>{" "}
            Run
          </span>
          <span style={{ marginLeft: "auto" }}>
            <kbd
              style={{
                fontFamily: "var(--font-mono)",
                border: "1px solid var(--line-2)",
                padding: "1px 5px",
                borderRadius: 4,
                background: "var(--ink)",
              }}
            >
              ESC
            </kbd>{" "}
            Close
          </span>
        </div>
      </div>
    </div>
  );
}
