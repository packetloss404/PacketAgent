import { useEffect, useMemo, useRef, useState } from "react";
import { I } from "../icons";
import { useApiData } from "../useApiData";
import { api, streamSandboxExec } from "@/lib/api";
import type { SandboxExecRecord, SandboxExecStatus, SandboxRuntimeInfo } from "@/lib/types";

const STATUS_FILTERS: Array<"all" | SandboxExecStatus> = [
  "all",
  "queued",
  "running",
  "success",
  "failed",
  "timeout",
  "canceled",
];
const EMPTY_EXECS: SandboxExecRecord[] = [];

function statusPillClass(status: SandboxExecStatus): string {
  switch (status) {
    case "success":
      return "good";
    case "running":
      return "info";
    case "queued":
      return "muted";
    case "failed":
    case "timeout":
      return "danger";
    case "canceled":
      return "warn";
    default:
      return "muted";
  }
}

function formatDuration(ms?: number): string {
  if (typeof ms !== "number" || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatRelative(iso?: string): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function SandboxView() {
  const status = useApiData(() => api.getSandboxStatus(), []);
  const runtimes = useApiData(() => api.listSandboxRuntimes(), []);
  const [filter, setFilter] = useState<"all" | SandboxExecStatus>("all");
  const execs = useApiData(() => api.listSandboxExecs({ limit: 50 }), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  // Composer state
  const [command, setCommand] = useState("");
  const [runtime, setRuntime] = useState<string>("");
  const [workingDir, setWorkingDir] = useState("/workspace");
  const [currentTime] = useState(Date.now);

  const defaultRuntime = runtimes.data?.find((candidate) => candidate.ready) ?? runtimes.data?.[0];
  const selectedRuntime = runtime || defaultRuntime?.id || "";
  const list = execs.data ?? EMPTY_EXECS;
  const filtered = filter === "all" ? list : list.filter((e) => e.status === filter);

  const selectedExec = useMemo(
    () => list.find((e) => e.id === selectedId) ?? null,
    [list, selectedId],
  );

  // Stats (24h window)
  const last24h = useMemo(() => {
    const cutoff = currentTime - 24 * 60 * 60 * 1000;
    return list.filter((e) => new Date(e.createdAt).getTime() >= cutoff);
  }, [currentTime, list]);
  const running = list.filter((e) => e.status === "running" || e.status === "queued").length;
  const failed24h = last24h.filter((e) => e.status === "failed" || e.status === "timeout").length;
  const durations = last24h
    .map((e) => e.durationMs)
    .filter((d): d is number => typeof d === "number" && d > 0)
    .sort((a, b) => a - b);
  const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : 0;

  const startExec = async () => {
    if (!command.trim() || working) return;
    setWorking(true);
    setComposerError(null);
    try {
      const exec = await api.startSandboxExec({
        command: command.trim(),
        runtime: selectedRuntime || undefined,
        workingDir: workingDir || undefined,
      });
      setCommand("");
      setSelectedId(exec.id);
      void execs.refresh();
    } catch (e) {
      setComposerError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const cancelSelected = async () => {
    if (!selectedExec) return;
    try {
      await api.cancelSandboxExec(selectedExec.id);
      void execs.refresh();
    } catch {
      /* ignore */
    }
  };

  return (
    <div style={{ padding: "26px 28px", maxWidth: 1320 }}>
      <p className="muted" style={{ fontSize: 13, marginBottom: 18 }}>
        Run commands in a sandboxed runtime. Streams stdout/stderr live.
      </p>

      <StatusPanel
        loading={status.loading}
        error={status.error}
        driver={status.data?.driver}
        available={status.data?.available}
        note={status.data?.note}
        runtimes={status.data?.runtimes ?? runtimes.data ?? []}
      />

      {/* Stats row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 10,
          margin: "18px 0",
        }}
      >
        <StatCard
          label="Total execs"
          value={String(list.length)}
          sub={`${last24h.length} in last 24h`}
        />
        <StatCard label="Running" value={String(running)} tone={running > 0 ? "info" : "default"} />
        <StatCard
          label="Failed · 24h"
          value={String(failed24h)}
          tone={failed24h > 0 ? "danger" : "good"}
        />
        <StatCard label="Median duration" value={formatDuration(median)} />
      </div>

      {/* Composer */}
      <Composer
        command={command}
        setCommand={setCommand}
        runtime={selectedRuntime}
        setRuntime={setRuntime}
        workingDir={workingDir}
        setWorkingDir={setWorkingDir}
        runtimes={runtimes.data ?? []}
        working={working}
        error={composerError}
        onStart={() => {
          void startExec();
        }}
      />

      {/* Filter row */}
      <div style={{ display: "flex", gap: 6, margin: "18px 0 12px", alignItems: "center" }}>
        <span className="kicker">FILTER</span>
        {STATUS_FILTERS.map((f) => (
          <button
            type="button"
            key={f}
            className="btn btn-sm"
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? "var(--bg-elev)" : "var(--panel)",
              color: filter === f ? "var(--silver-50)" : "var(--silver-300)",
              borderColor: filter === f ? "var(--line-3)" : "var(--line-2)",
            }}
          >
            {f}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => void execs.refresh()}
        >
          Refresh
        </button>
      </div>

      {execs.loading && (
        <div className="muted" style={{ padding: 16 }}>
          Loading executions…
        </div>
      )}
      {execs.error && (
        <div className="card" style={{ padding: 16, color: "var(--danger)" }}>
          {execs.error}
        </div>
      )}

      <ExecTable
        execs={filtered}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCancel={async (id) => {
          await api.cancelSandboxExec(id).catch(() => {});
          void execs.refresh();
        }}
      />

      {selectedExec && (
        <div style={{ marginTop: 18 }}>
          <SelectedExecPanel
            key={selectedExec.id}
            exec={selectedExec}
            onCancel={() => {
              void cancelSelected();
            }}
            onClose={() => setSelectedId(null)}
            onUpdate={() => {
              void execs.refresh();
            }}
          />
        </div>
      )}
    </div>
  );
}

function StatusPanel({
  loading,
  error,
  driver,
  available,
  note,
  runtimes,
}: {
  loading: boolean;
  error: string | null;
  driver?: "docker" | "native";
  available?: boolean;
  note?: string;
  runtimes: SandboxRuntimeInfo[];
}) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <I.cpu size={15} style={{ color: "var(--green)" }} />
        <div className="kicker">DRIVER</div>
        {loading && (
          <span className="muted" style={{ fontSize: 12 }}>
            Loading…
          </span>
        )}
        {!loading && driver && (
          <span className={`pill ${driver === "docker" ? "good" : "warn"}`}>
            <span className="dot"></span>
            {driver}
          </span>
        )}
        {!loading && driver === "native" && <span className="pill danger">INSECURE</span>}
        {!loading && available !== undefined && (
          <span className={`pill ${available ? "good" : "danger"}`}>
            <span className="dot"></span>
            {available ? "available" : "unavailable"}
          </span>
        )}
        <span className="mono muted" style={{ fontSize: 11, marginLeft: "auto" }}>
          {runtimes.length} runtime{runtimes.length === 1 ? "" : "s"}
        </span>
      </div>
      {error && (
        <div className="muted" style={{ fontSize: 12, color: "var(--danger)", marginBottom: 8 }}>
          {error}
        </div>
      )}
      {note && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          {note}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {runtimes.map((r) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              border: "1px solid var(--line)",
              borderRadius: 6,
              background: "var(--panel)",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: r.ready ? "var(--green)" : "var(--silver-500)",
                boxShadow: r.ready ? "0 0 6px var(--green)" : "none",
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mono" style={{ fontSize: 12, color: "var(--silver-50)" }}>
                {r.id}
              </div>
              {(r.image || r.description) && (
                <div
                  className="mono muted"
                  style={{
                    fontSize: 10.5,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.image ?? r.description ?? ""}
                </div>
              )}
            </div>
            <span className={`pill ${r.ready ? "good" : "muted"}`}>
              {r.ready ? "ready" : "off"}
            </span>
          </div>
        ))}
        {runtimes.length === 0 && !loading && (
          <div className="muted" style={{ fontSize: 12, padding: 8 }}>
            No runtimes registered.
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "good" | "danger" | "info";
}) {
  const color =
    tone === "good"
      ? "var(--green)"
      : tone === "danger"
        ? "var(--danger)"
        : tone === "info"
          ? "var(--silver-50)"
          : "var(--silver-50)";
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="kicker">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 500, marginTop: 4, color }}>{value}</div>
      {sub && (
        <div className="mono muted" style={{ fontSize: 11 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Composer({
  command,
  setCommand,
  runtime,
  setRuntime,
  workingDir,
  setWorkingDir,
  runtimes,
  working,
  error,
  onStart,
}: {
  command: string;
  setCommand: (v: string) => void;
  runtime: string;
  setRuntime: (v: string) => void;
  workingDir: string;
  setWorkingDir: (v: string) => void;
  runtimes: SandboxRuntimeInfo[];
  working: boolean;
  error: string | null;
  onStart: () => void;
}) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <I.zap size={14} style={{ color: "var(--green)" }} />
        <div className="kicker">RUN COMMAND</div>
      </div>
      <textarea
        className="field mono"
        style={{ minHeight: 70, fontSize: 12.5, resize: "vertical", marginBottom: 8 }}
        placeholder="e.g. echo hello   or   npm test   or   ls -la"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label className="kicker" style={{ marginRight: 4 }}>
          RUNTIME
        </label>
        <select
          className="field"
          value={runtime}
          onChange={(e) => setRuntime(e.target.value)}
          style={{ padding: "5px 8px", fontSize: 12, minWidth: 140 }}
        >
          {runtimes.length === 0 && <option value="">— none —</option>}
          {runtimes.map((r) => (
            <option key={r.id} value={r.id} disabled={!r.ready}>
              {r.id}
              {r.ready ? "" : " (off)"}
            </option>
          ))}
        </select>
        <label className="kicker" style={{ marginLeft: 8, marginRight: 4 }}>
          CWD
        </label>
        <input
          className="field mono"
          style={{ padding: "5px 8px", fontSize: 12, width: 180 }}
          value={workingDir}
          onChange={(e) => setWorkingDir(e.target.value)}
          placeholder="/workspace"
        />
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {error && (
            <span className="mono" style={{ fontSize: 11, color: "var(--danger)" }}>
              ERR · {error}
            </span>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!command.trim() || working}
            onClick={onStart}
          >
            {working ? (
              <span className="spin">
                <I.refresh size={12} />
              </span>
            ) : (
              <I.play size={12} />
            )}
            {working ? " Starting…" : " Start"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ExecTable({
  execs,
  selectedId,
  onSelect,
  onCancel,
}: {
  execs: SandboxExecRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Status</th>
            <th>Command</th>
            <th>Runtime</th>
            <th>Duration</th>
            <th>Started</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {execs.map((e) => {
            const isSelected = e.id === selectedId;
            const cancellable = e.status === "running" || e.status === "queued";
            return (
              <tr key={e.id} style={{ background: isSelected ? "var(--bg-elev)" : undefined }}>
                <td>
                  <span className={`pill ${statusPillClass(e.status)}`}>
                    <span className="dot"></span>
                    {e.status}
                  </span>
                </td>
                <td
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: "var(--silver-50)",
                    maxWidth: 360,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.command}
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {e.runtime}
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {formatDuration(e.durationMs)}
                </td>
                <td className="mono muted" style={{ fontSize: 11.5 }}>
                  {formatRelative(e.startedAt ?? e.createdAt)}
                </td>
                <td style={{ display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ padding: "3px 8px" }}
                    onClick={() => onSelect(e.id)}
                  >
                    View
                  </button>
                  {cancellable && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: "3px 8px" }}
                      onClick={() => onCancel(e.id)}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {execs.length === 0 && (
            <tr>
              <td colSpan={6} className="muted" style={{ padding: 18, textAlign: "center" }}>
                No executions match this filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface LogLine {
  stream: "stdout" | "stderr";
  data: string;
}

export function SelectedExecPanel({
  exec,
  onCancel,
  onClose,
  onUpdate,
}: {
  exec: SandboxExecRecord;
  onCancel: () => void;
  onClose: () => void;
  onUpdate?: () => void;
}) {
  const [tab, setTab] = useState<"stdout" | "stderr">("stdout");
  const [follow, setFollow] = useState(true);
  const [stdout, setStdout] = useState<string>(exec.stdoutPreview ?? "");
  const [stderr, setStderr] = useState<string>(exec.stderrPreview ?? "");
  const [liveExec, setLiveExec] = useState<SandboxExecRecord>(exec);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const stdoutRef = useRef<HTMLPreElement | null>(null);
  const stderrRef = useRef<HTMLPreElement | null>(null);

  // Stream while exec is live
  useEffect(() => {
    if (liveExec.status !== "running" && liveExec.status !== "queued") return;
    const close = streamSandboxExec(exec.id, {
      onChunk: (msg: LogLine) => {
        if (msg.stream === "stdout") setStdout((s) => s + msg.data);
        else setStderr((s) => s + msg.data);
      },
      onStatus: (next) => setLiveExec(next),
      onDone: (next) => {
        setLiveExec(next);
        onUpdate?.();
      },
      onError: (e) => setStreamErr(e.message),
    });
    return close;
  }, [exec.id, liveExec.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-tail
  useEffect(() => {
    if (!follow) return;
    if (tab === "stdout" && stdoutRef.current)
      stdoutRef.current.scrollTop = stdoutRef.current.scrollHeight;
    if (tab === "stderr" && stderrRef.current)
      stderrRef.current.scrollTop = stderrRef.current.scrollHeight;
  }, [stdout, stderr, follow, tab]);

  const cancellable = liveExec.status === "running" || liveExec.status === "queued";

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span className={`pill ${statusPillClass(liveExec.status)}`}>
          <span className="dot"></span>
          {liveExec.status}
        </span>
        <div
          className="mono"
          style={{
            fontSize: 12,
            color: "var(--silver-50)",
            maxWidth: 540,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {liveExec.command}
        </div>
        <span className="mono muted" style={{ fontSize: 11 }}>
          {liveExec.runtime} · {liveExec.id.slice(0, 12)}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {typeof liveExec.exitCode === "number" && (
            <span className="mono muted" style={{ fontSize: 11 }}>
              exit {liveExec.exitCode}
            </span>
          )}
          <span className="mono muted" style={{ fontSize: 11 }}>
            {formatDuration(liveExec.durationMs)}
          </span>
          {cancellable && (
            <button type="button" className="btn btn-sm" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {liveExec.errorMessage && (
        <div style={{ padding: "8px 16px", color: "var(--danger)", fontSize: 12 }} className="mono">
          ERR · {liveExec.errorMessage}
        </div>
      )}
      {streamErr && (
        <div
          style={{ padding: "6px 16px", color: "var(--warn)", fontSize: 11.5 }}
          className="mono muted"
        >
          stream · {streamErr}
        </div>
      )}

      <div className="tabbar">
        <button
          type="button"
          className={`tab ${tab === "stdout" ? "active" : ""}`}
          onClick={() => setTab("stdout")}
          aria-pressed={tab === "stdout"}
        >
          <I.activity size={12} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          stdout
        </button>
        <button
          type="button"
          className={`tab ${tab === "stderr" ? "active" : ""}`}
          onClick={() => setTab("stderr")}
          aria-pressed={tab === "stderr"}
        >
          <I.alert size={12} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          stderr
        </button>
        <div
          style={{
            marginLeft: "auto",
            padding: "0 12px",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <label
            className="mono muted"
            style={{
              fontSize: 11,
              display: "flex",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
            }}
          >
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            follow tail
          </label>
        </div>
      </div>

      <pre
        ref={tab === "stdout" ? stdoutRef : stderrRef}
        className="mono"
        style={{
          margin: 0,
          padding: 12,
          fontSize: 11.5,
          lineHeight: 1.55,
          background: "var(--ink)",
          color: tab === "stderr" ? "var(--danger)" : "var(--silver-200)",
          height: 320,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {tab === "stdout"
          ? stdout ||
            (liveExec.status === "queued" ? "(queued — waiting for runtime)" : "(no stdout)")
          : stderr || "(no stderr)"}
      </pre>
    </div>
  );
}
