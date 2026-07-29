import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { I } from "../icons";
import { Topbar } from "../Shell";
import { api } from "@/lib/api";
import type {
  AgentRunDetailPayload,
  AgentRunLogEntry,
  AgentRunRecord,
  AgentRunTrace,
  AgentRunTraceSpan,
} from "@/lib/types";
import { triggerLabel, formatDuration } from "@/lib/agent-runtime";
import { RunTranscript, ToolCallTimeline } from "./agent-editor";
import {
  flattenTraceSpans,
  getTraceState,
  summarizeTrace,
  traceStatusTone,
} from "./run-trace-utils";

type RunAction = "cancel" | "retry" | "diagnose";

interface LoadedRunDetail extends AgentRunDetailPayload {
  agentName?: string;
  legacyFallback?: boolean;
}

export function RunDeepView() {
  const { id = "" } = useParams();
  return <RunDeepContent key={id} id={id} />;
}

function RunDeepContent({ id }: { id: string }) {
  const navigate = useNavigate();
  const [run, setRun] = useState<AgentRunRecord | null>(null);
  const [trace, setTrace] = useState<AgentRunTrace | null>(null);
  const [agentName, setAgentName] = useState<string>("");
  const [legacyFallback, setLegacyFallback] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<RunAction | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const detail = await loadAgentRunDetail(id);
        if (!mounted) return;
        setRun(detail.run);
        setTrace(detail.trace ?? null);
        setAgentName(detail.agentName ?? "");
        setLegacyFallback(Boolean(detail.legacyFallback));
      } catch (e) {
        if (mounted) setLoadError((e as Error).message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [id]);

  const traceSummary = useMemo(() => summarizeTrace(trace), [trace]);

  const handleCancel = async () => {
    if (!run) return;
    setActionBusy("cancel");
    setActionError(null);
    try {
      const next = await api.cancelAgentRun(run.id);
      setRun(next);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  const handleRetry = async () => {
    if (!run) return;
    setActionBusy("retry");
    setActionError(null);
    try {
      const next = await api.retryAgentRun(run.id);
      if (next.id !== run.id) {
        navigate(`/runs/${next.id}`);
      } else {
        setRun(next);
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  const handleDiagnose = async () => {
    if (!run) return;
    setActionBusy("diagnose");
    setActionError(null);
    try {
      const d = await api.diagnoseAgentRun(run.id);
      setDiagnostic(d?.summary ?? "No diagnostic available.");
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  if (loading) {
    return (
      <>
        <Topbar crumbs={["__WS__", "Runs", id]} />
        <div className="muted" style={{ padding: 26 }}>
          Loading run...
        </div>
      </>
    );
  }
  if (loadError || !run) {
    return (
      <>
        <Topbar crumbs={["__WS__", "Runs", id]} />
        <div style={{ padding: "26px 28px" }}>
          <button type="button" className="btn btn-sm" onClick={() => navigate("/runs")}>
            <I.arrow size={11} style={{ transform: "scaleX(-1)" }} /> All runs
          </button>
          <div className="card" style={{ padding: 22, marginTop: 18, color: "var(--danger)" }}>
            {loadError ?? "Run not found."}
          </div>
        </div>
      </>
    );
  }

  const status = run.status;
  const statusTone = runStatusTone(status);

  return (
    <>
      <Topbar
        crumbs={["__WS__", "Runs", agentName || run.title]}
        actions={
          <>
            <button type="button" className="top-btn" onClick={() => navigate("/runs")}>
              <I.activity size={13} /> All runs
            </button>
            {run.canCancel && (
              <button
                type="button"
                className="top-btn"
                disabled={Boolean(actionBusy)}
                onClick={() => {
                  void handleCancel();
                }}
              >
                {actionBusy === "cancel" ? (
                  <span className="spin">
                    <I.refresh size={13} />
                  </span>
                ) : (
                  <I.pause size={13} />
                )}{" "}
                Cancel
              </button>
            )}
            {run.canRetry && (
              <button
                type="button"
                className="top-btn"
                disabled={Boolean(actionBusy)}
                onClick={() => {
                  void handleRetry();
                }}
              >
                {actionBusy === "retry" ? (
                  <span className="spin">
                    <I.refresh size={13} />
                  </span>
                ) : (
                  <I.refresh size={13} />
                )}{" "}
                Retry
              </button>
            )}
            <button
              type="button"
              className="top-btn"
              disabled={Boolean(actionBusy)}
              onClick={() => {
                void handleDiagnose();
              }}
            >
              {actionBusy === "diagnose" ? (
                <span className="spin">
                  <I.refresh size={13} />
                </span>
              ) : (
                <I.sparkle size={13} />
              )}{" "}
              Diagnose
            </button>
          </>
        }
      />
      <div style={{ padding: "26px 28px 60px", maxWidth: 1240 }}>
        <div className="kicker">RUN - {run.id}</div>
        <h1 className="h1" style={{ fontSize: 28, marginTop: 4, marginBottom: 6 }}>
          {run.title}
        </h1>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 18,
            flexWrap: "wrap",
          }}
        >
          <span className={`pill ${statusTone}`}>
            <span className="dot"></span>
            {status}
          </span>
          {agentName && (
            <span className="mono muted" style={{ fontSize: 11.5 }}>
              agent: {agentName}
            </span>
          )}
          <span className="mono muted" style={{ fontSize: 11.5 }}>
            {triggerLabel(run.triggerKind)}
          </span>
          {run.modelUsed && (
            <span className="mono muted" style={{ fontSize: 11.5 }}>
              {run.modelUsed}
            </span>
          )}
          {typeof run.costUsd === "number" && (
            <span className="mono muted" style={{ fontSize: 11.5 }}>
              {formatMoney(run.costUsd)}
            </span>
          )}
          {formatRunDuration(run) !== "n/a" && (
            <span className="mono muted" style={{ fontSize: 11.5 }}>
              {formatRunDuration(run)}
            </span>
          )}
          {legacyFallback && <span className="pill muted">legacy detail</span>}
        </div>

        {actionError && (
          <Notice tone="danger" label="Action error">
            {actionError}
          </Notice>
        )}

        {run.error && (
          <Notice tone="danger" label="Run error">
            {run.error}
          </Notice>
        )}

        {diagnostic && (
          <Notice tone="good" label="Diagnostic">
            {diagnostic}
          </Notice>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 10,
            marginBottom: 16,
          }}
        >
          <SummaryCard label="Status" value={status} detail={statusDetail(run)} tone={statusTone} />
          <SummaryCard
            label="Duration"
            value={formatRunDuration(run)}
            detail={formatDateRange(run.startedAt, run.completedAt)}
          />
          <SummaryCard
            label="Model"
            value={run.modelUsed ?? "n/a"}
            detail={triggerLabel(run.triggerKind)}
          />
          <SummaryCard
            label="Cost"
            value={typeof run.costUsd === "number" ? formatMoney(run.costUsd) : "n/a"}
            detail={
              traceSummary.costUsd !== null
                ? `trace ${formatMoney(traceSummary.costUsd)}`
                : undefined
            }
          />
          <SummaryCard
            label="Trace"
            value={String(traceSummary.spans)}
            detail={`${traceSummary.modelCalls} model, ${traceSummary.toolCalls} tool`}
          />
        </div>

        <Section
          title="Trace spans"
          meta={
            trace ? `${traceSummary.spans} span${traceSummary.spans === 1 ? "" : "s"}` : "legacy"
          }
        >
          <TraceSpans trace={trace} run={run} />
        </Section>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
            gap: 16,
            marginTop: 16,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Section
              title="Inputs"
              meta={`${Object.keys(run.inputs ?? {}).length} field${Object.keys(run.inputs ?? {}).length === 1 ? "" : "s"}`}
            >
              <InputsPanel inputs={run.inputs} />
            </Section>

            <Section title="Output" meta={run.output ? `${run.output.length} chars` : "empty"}>
              {run.output ? (
                <CodeBlock value={run.output} />
              ) : (
                <EmptyState>This run has no output payload.</EmptyState>
              )}
            </Section>

            <Section
              title="Transcript"
              meta={`${run.transcript?.length ?? 0} step${run.transcript?.length === 1 ? "" : "s"}`}
            >
              <RunTranscript steps={run.transcript} />
            </Section>
          </div>

          <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Section title="Tool calls" meta={`${run.toolCalls?.length ?? 0}`}>
              {run.toolCalls && run.toolCalls.length > 0 ? (
                <ToolCallTimeline calls={run.toolCalls} />
              ) : (
                <EmptyState>No tool calls were captured for this run.</EmptyState>
              )}
            </Section>

            <Section title="Logs" meta={`${run.logs?.length ?? 0}`}>
              <RunLogs logs={run.logs} />
            </Section>

            <Section title="Metadata">
              <MetadataPanel run={run} trace={trace} />
            </Section>
          </aside>
        </div>
      </div>
    </>
  );
}

async function loadAgentRunDetail(runId: string): Promise<LoadedRunDetail> {
  try {
    return await api.getAgentRunDetail(runId);
  } catch (e) {
    const error = e as Error & { status?: number };
    if (error.status !== 404 && error.status !== 405) throw e;
  }

  // Keep older backends usable while the detail endpoint is rolling out.
  const allRuns = await api.listAgentRuns();
  const match = allRuns.find((r) => r.id === runId);
  if (!match) throw new Error("Run not found.");
  if (!match.agentId) return { run: match, trace: null, legacyFallback: true };

  try {
    const agentDetail = await api.getAgent(match.agentId);
    const full = agentDetail.runs.find((r) => r.id === runId) ?? match;
    return { run: full, trace: null, agentName: agentDetail.agent.name, legacyFallback: true };
  } catch {
    return { run: match, trace: null, legacyFallback: true };
  }
}

function SummaryCard({
  label,
  value,
  detail,
  tone = "muted",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "good" | "warn" | "danger" | "info" | "muted";
}) {
  return (
    <div className="card" style={{ padding: 14, minWidth: 0 }}>
      <div className="kicker">{label}</div>
      <div
        style={{
          fontSize: 21,
          fontWeight: 500,
          marginTop: 5,
          color: toneColor(tone),
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
      {detail && (
        <div
          className="mono muted"
          style={{ fontSize: 10.5, marginTop: 2, wordBreak: "break-word" }}
        >
          {detail}
        </div>
      )}
    </div>
  );
}

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <div className="card" style={{ padding: 18, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <div className="kicker">{title}</div>
        {meta && (
          <div className="mono muted" style={{ fontSize: 10.5, marginLeft: "auto" }}>
            {meta}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function Notice({
  tone,
  label,
  children,
}: {
  tone: "good" | "danger";
  label: string;
  children: ReactNode;
}) {
  const color = tone === "good" ? "var(--green)" : "var(--danger)";
  const bg = tone === "good" ? "rgba(184,242,92,0.06)" : "rgba(242,107,92,0.06)";
  const border = tone === "good" ? "rgba(184,242,92,0.3)" : "rgba(242,107,92,0.3)";
  return (
    <div
      className="card"
      style={{ padding: "12px 14px", marginBottom: 14, borderColor: border, background: bg }}
    >
      <div className="kicker" style={{ marginBottom: 4, color }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--silver-200)",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function TraceSpans({ trace, run }: { trace: AgentRunTrace | null; run: AgentRunRecord }) {
  const state = getTraceState(trace);
  if (state === "legacy") {
    return (
      <EmptyState>
        This run does not include a trace envelope. Transcript, tool calls, and logs below are the
        available legacy record.
      </EmptyState>
    );
  }
  if (state === "empty") {
    return (
      <EmptyState>Trace metadata was returned, but no spans were captured for this run.</EmptyState>
    );
  }

  const rows = flattenTraceSpans(trace);
  const runStartedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const total = Math.max(1, ...rows.map((row) => row.durationMs ?? 0));

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((row, index) => (
        <TraceSpanRow
          key={row.span.id}
          span={row.span}
          depth={row.depth}
          durationMs={row.durationMs}
          totalDurationMs={total}
          runStartedAt={runStartedAt}
          first={index === 0}
        />
      ))}
    </div>
  );
}

function TraceSpanRow({
  span,
  depth,
  durationMs,
  totalDurationMs,
  runStartedAt,
  first,
}: {
  span: AgentRunTraceSpan;
  depth: number;
  durationMs: number | null;
  totalDurationMs: number;
  runStartedAt: number | null;
  first: boolean;
}) {
  const tone = traceStatusTone(span.status);
  const relativeStart = relativeSpanStart(span.startedAt, runStartedAt);
  const width = durationMs ? Math.max(4, Math.min(100, (durationMs / totalDurationMs) * 100)) : 0;
  const kind = span.kind ?? span.type ?? "span";
  const hasDetails =
    span.input !== undefined ||
    span.output !== undefined ||
    span.data ||
    span.attributes ||
    span.events?.length ||
    span.error;

  return (
    <div style={{ padding: "10px 0", borderTop: first ? "none" : "1px solid var(--line)" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto auto",
          gap: 10,
          alignItems: "start",
        }}
      >
        <div style={{ minWidth: 0, paddingLeft: Math.min(depth, 6) * 16 }}>
          <div
            style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flexWrap: "wrap" }}
          >
            <span className={`pill ${tone}`}>
              <span className="dot"></span>
              {span.status ?? "unknown"}
            </span>
            <span
              className="mono"
              style={{
                color: "var(--silver-50)",
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "100%",
              }}
            >
              {spanTitle(span)}
            </span>
            <span className="pill muted">{kind}</span>
          </div>
          {span.summary && (
            <div
              className="muted"
              style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}
            >
              {span.summary}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <div
              style={{
                height: 5,
                flex: 1,
                minWidth: 80,
                background: "var(--ink)",
                border: "1px solid var(--line)",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${width}%`,
                  background:
                    tone === "danger"
                      ? "var(--danger)"
                      : tone === "warn"
                        ? "var(--warn)"
                        : tone === "good"
                          ? "var(--green-deep)"
                          : "var(--info)",
                }}
              />
            </div>
            {relativeStart && (
              <span className="mono muted" style={{ fontSize: 10.5 }}>
                {relativeStart}
              </span>
            )}
          </div>
          {span.error && (
            <div
              className="mono"
              style={{ marginTop: 6, fontSize: 11, color: "var(--danger)", whiteSpace: "pre-wrap" }}
            >
              {span.error}
            </div>
          )}
          {hasDetails && (
            <details style={{ marginTop: 8 }}>
              <summary className="mono muted" style={{ cursor: "pointer", fontSize: 10.5 }}>
                details
              </summary>
              <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                {span.input !== undefined && <TraceDetail label="Input" value={span.input} />}
                {span.output !== undefined && <TraceDetail label="Output" value={span.output} />}
                {span.data && <TraceDetail label="Data" value={span.data} />}
                {span.attributes && <TraceDetail label="Attributes" value={span.attributes} />}
                {span.events && span.events.length > 0 && (
                  <TraceDetail label="Events" value={span.events} />
                )}
              </div>
            </details>
          )}
        </div>
        <span
          className="mono muted"
          style={{ fontSize: 10.5, textAlign: "right", whiteSpace: "nowrap" }}
        >
          {formatMaybeDuration(durationMs)}
        </span>
        <span
          className="mono muted"
          style={{ fontSize: 10.5, textAlign: "right", whiteSpace: "nowrap" }}
        >
          {spanCost(span)}
        </span>
      </div>
    </div>
  );
}

function TraceDetail({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="kicker" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <CodeBlock value={stringifyValue(value)} />
    </div>
  );
}

function InputsPanel({ inputs }: { inputs: AgentRunRecord["inputs"] }) {
  const entries = Object.entries(inputs ?? {});
  if (entries.length === 0)
    return <EmptyState>No input fields were recorded for this run.</EmptyState>;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(100px, auto) minmax(0, 1fr)",
        gap: "7px 12px",
        fontSize: 11.5,
      }}
    >
      {entries.map(([key, value]) => (
        <div key={key} style={{ display: "contents" }}>
          <span className="mono muted" style={{ wordBreak: "break-word" }}>
            {key}
          </span>
          <span
            className="mono"
            style={{ color: "var(--silver-200)", wordBreak: "break-word", whiteSpace: "pre-wrap" }}
          >
            {renderInlineValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function RunLogs({ logs }: { logs: AgentRunLogEntry[] | undefined }) {
  if (!logs || logs.length === 0)
    return <EmptyState>No logs were captured for this run.</EmptyState>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {logs.map((entry, i) => (
        <div
          key={`${entry.at}-${i}`}
          className="mono"
          style={{
            fontSize: 11.5,
            display: "grid",
            gridTemplateColumns: "50px minmax(0, 1fr) auto",
            gap: 10,
            alignItems: "baseline",
          }}
        >
          <span
            style={{
              color:
                entry.level === "error"
                  ? "var(--danger)"
                  : entry.level === "warn"
                    ? "var(--warn)"
                    : "var(--silver-500)",
            }}
          >
            {entry.level.toUpperCase()}
          </span>
          <span
            style={{
              color: entry.level === "error" ? "var(--silver-100)" : "var(--silver-300)",
              minWidth: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {entry.message}
          </span>
          <span className="muted" style={{ fontSize: 10.5, whiteSpace: "nowrap" }}>
            {formatTime(entry.at)}
          </span>
        </div>
      ))}
    </div>
  );
}

function MetadataPanel({ run, trace }: { run: AgentRunRecord; trace: AgentRunTrace | null }) {
  const rows: Array<[string, ReactNode]> = [
    ["Run ID", run.id],
    ["Workspace", run.workspaceId],
    ["Agent ID", run.agentId ?? "n/a"],
    ["Created", formatDate(run.createdAt)],
    ["Started", formatDate(run.startedAt)],
    ["Completed", formatDate(run.completedAt)],
    ["Updated", formatDate(run.updatedAt)],
    ["Model", run.modelUsed ?? "n/a"],
    ["Cost", typeof run.costUsd === "number" ? formatMoney(run.costUsd) : "n/a"],
    ["Trace ID", trace?.id ?? "n/a"],
    ["Trace source", trace?.source ?? "n/a"],
    ["Trace generated", formatDate(trace?.generatedAt)],
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "110px minmax(0, 1fr)",
        gap: "8px 10px",
        fontSize: 12,
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <div className="muted">{label}</div>
          <div className="mono" style={{ wordBreak: "break-word", color: "var(--silver-200)" }}>
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre
      className="mono"
      style={{
        margin: 0,
        padding: 12,
        background: "var(--ink)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        fontSize: 11.5,
        lineHeight: 1.6,
        color: "var(--silver-200)",
        whiteSpace: "pre-wrap",
        overflow: "auto",
        maxHeight: 420,
      }}
    >
      {value}
    </pre>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono muted"
      style={{
        fontSize: 11.5,
        padding: "10px 12px",
        border: "1px dashed var(--line-2)",
        borderRadius: 6,
      }}
    >
      {children}
    </div>
  );
}

function runStatusTone(
  status: AgentRunRecord["status"],
): "good" | "warn" | "danger" | "info" | "muted" {
  switch (status) {
    case "success":
      return "good";
    case "failed":
      return "danger";
    case "running":
      return "warn";
    case "queued":
      return "info";
    default:
      return "muted";
  }
}

function toneColor(tone: "good" | "warn" | "danger" | "info" | "muted") {
  switch (tone) {
    case "good":
      return "var(--green)";
    case "warn":
      return "var(--warn)";
    case "danger":
      return "var(--danger)";
    case "info":
      return "var(--info)";
    default:
      return "var(--silver-50)";
  }
}

function statusDetail(run: AgentRunRecord): string {
  if (run.status === "running" && run.startedAt) return `started ${formatDate(run.startedAt)}`;
  if (run.status === "queued") return `queued ${formatDate(run.createdAt)}`;
  if (run.completedAt) return `completed ${formatDate(run.completedAt)}`;
  return `created ${formatDate(run.createdAt)}`;
}

function formatRunDuration(run: AgentRunRecord): string {
  if (typeof run.durationMs === "number" && run.durationMs > 0)
    return formatDuration(run.durationMs);
  if (run.startedAt && run.completedAt) {
    const start = new Date(run.startedAt).getTime();
    const end = new Date(run.completedAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
      return formatDuration(end - start);
  }
  return "n/a";
}

function formatMaybeDuration(ms: number | null | undefined): string {
  return typeof ms === "number" && ms > 0 ? formatDuration(ms) : "n/a";
}

function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}

function formatDateRange(start: string | undefined, end: string | undefined): string | undefined {
  if (!start && !end) return undefined;
  if (start && end) return `${formatTime(start)} - ${formatTime(end)}`;
  return start ? `started ${formatTime(start)}` : `completed ${formatTime(end!)}`;
}

function relativeSpanStart(
  startedAt: string | undefined,
  runStartedAt: number | null,
): string | null {
  if (!startedAt || runStartedAt === null) return null;
  const spanStart = new Date(startedAt).getTime();
  if (!Number.isFinite(spanStart) || spanStart < runStartedAt) return null;
  const delta = spanStart - runStartedAt;
  if (delta === 0) return "+0ms";
  return `+${formatDuration(delta)}`;
}

function spanTitle(span: AgentRunTraceSpan): string {
  return span.name ?? span.title ?? span.toolName ?? span.modelUsed ?? span.model ?? span.id;
}

function spanCost(span: AgentRunTraceSpan): string {
  if (typeof span.costUsd === "number") return formatMoney(span.costUsd);
  if (typeof span.data?.costUsd === "number") return formatMoney(span.data.costUsd);
  return "n/a";
}

function stringifyValue(value: unknown, max = 5000): string {
  if (typeof value === "string")
    return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? `${s.slice(0, max)}\n[truncated]` : s;
  } catch {
    return String(value);
  }
}

function renderInlineValue(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return stringifyValue(value, 1200);
}
