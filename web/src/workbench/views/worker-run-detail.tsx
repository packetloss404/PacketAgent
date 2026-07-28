import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type {
  WorkerAttentionView,
  WorkerBudgetPolicy,
  WorkerBudgetUsage,
  WorkerRunDetail,
  WorkerRunStatus,
} from "@/lib/types";
import { Topbar } from "../Shell";
import { useApiData } from "../useApiData";
import { workerRunDetailAccessibleState } from "../worker-operations-state";

type RunControlAction = "pause" | "resume" | "stop" | "revoke";
type AttentionAction = "approve-once" | "approve-for-run" | "reject";

export function WorkerRunDetailView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const detail = useApiData(() => api.getWorkerRunDetail(id), [id]);
  const refreshDetail = detail.refresh;
  const latestSequence = useRef(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  useEffect(() => {
    latestSequence.current = Math.max(
      latestSequence.current,
      detail.data?.run.rollup.computedThroughSequence ?? 0,
    );
  }, [detail.data]);

  useEffect(() => {
    if (!id || typeof EventSource === "undefined") return;
    const params = new URLSearchParams({
      workerRunId: id,
      afterSequence: String(latestSequence.current),
    });
    const source = new EventSource(`/api/app/workers/events/stream?${params.toString()}`, {
      withCredentials: true,
    });
    const refresh = () => {
      void refreshDetail();
    };
    const onWorkerEvent = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as { sequence?: number };
        if (typeof parsed.sequence === "number") {
          latestSequence.current = Math.max(latestSequence.current, parsed.sequence);
        }
      } catch {
        // The read model remains authoritative; a malformed notification only triggers refresh.
      }
      refresh();
    };
    source.addEventListener("worker.event", onWorkerEvent as EventListener);
    source.addEventListener("worker.stream.error", refresh);
    source.onerror = refresh;
    const pollingFallback = window.setInterval(refresh, 15_000);
    return () => {
      window.clearInterval(pollingFallback);
      source.close();
    };
  }, [id, refreshDetail]);

  const accessibleState = workerRunDetailAccessibleState({
    loading: detail.loading,
    error: detail.error,
    hasDetail: detail.data !== null,
  });
  const run = detail.data?.run;

  const runControl = async (action: RunControlAction) => {
    if (!run) return;
    setBusy(action);
    setActionError(null);
    setActionNotice(null);
    try {
      if (action === "revoke") {
        await api.revokeWorkerDeployment(run.deployment.id, run.deployment.revision);
      } else {
        await api.controlWorkerRun(run.id, action, run.revision);
      }
      setActionNotice(
        action === "revoke"
          ? "Deployment revocation was accepted."
          : `Worker ${action} command was accepted.`,
      );
      await detail.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      await detail.refresh();
    } finally {
      setBusy(null);
    }
  };

  const resolveAttention = async (attention: WorkerAttentionView, action: AttentionAction) => {
    setBusy(`${attention.id}:${action}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await api.resolveWorkerAttention(attention.id, action, attention.runRevision);
      setActionNotice(
        action === "reject"
          ? "The requested operation was rejected."
          : action === "approve-for-run"
            ? "The capability was approved for this run."
            : "The operation was approved once.",
      );
      await detail.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      await detail.refresh();
    } finally {
      setBusy(null);
    }
  };

  if (accessibleState.kind === "loading") {
    return (
      <>
        <Topbar crumbs={["__WS__", "Runs", "Workers", id]} />
        <div
          className="muted"
          role={accessibleState.role}
          aria-live={accessibleState.ariaLive}
          style={{ padding: 26 }}
        >
          {accessibleState.message}
        </div>
      </>
    );
  }

  if (accessibleState.kind === "error" || !detail.data || !run) {
    return (
      <>
        <Topbar crumbs={["__WS__", "Runs", "Workers", id]} />
        <div style={{ padding: "26px 28px" }}>
          <button className="btn btn-sm" onClick={() => navigate("/runs")}>
            Back to Workers
          </button>
          <div
            className="card"
            role={accessibleState.kind === "error" ? accessibleState.role : "alert"}
            aria-live={accessibleState.kind === "error" ? accessibleState.ariaLive : "assertive"}
            style={{ padding: 22, marginTop: 18, color: "var(--danger)" }}
          >
            {accessibleState.kind === "error" ? accessibleState.message : "Worker run not found."}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        crumbs={["__WS__", "Runs", "Workers", run.definition.name]}
        actions={
          <>
            <button className="top-btn" onClick={() => navigate("/runs")}>
              All Workers
            </button>
            {run.controls.canPause && (
              <ControlButton
                label="Pause"
                busy={busy === "pause"}
                disabled={busy !== null}
                onClick={() => void runControl("pause")}
              />
            )}
            {run.controls.canResume && (
              <ControlButton
                label="Resume"
                busy={busy === "resume"}
                disabled={busy !== null}
                onClick={() => void runControl("resume")}
              />
            )}
            {run.controls.canStop && (
              <ControlButton
                label="Stop"
                busy={busy === "stop"}
                disabled={busy !== null}
                onClick={() => void runControl("stop")}
              />
            )}
            {run.controls.canRevokeDeployment && (
              <ControlButton
                label="Revoke deployment"
                busy={busy === "revoke"}
                disabled={busy !== null}
                onClick={() => void runControl("revoke")}
              />
            )}
          </>
        }
      />
      <div style={{ padding: "26px 28px 60px", maxWidth: 1320 }}>
        <div className="kicker">WORKER RUN · {run.id}</div>
        <h1 className="h1" style={{ fontSize: 28, marginTop: 4, marginBottom: 6 }}>
          {run.definition.name}
        </h1>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            flexWrap: "wrap",
            marginBottom: 18,
          }}
        >
          <WorkerStatus status={run.status} />
          <span className="mono muted">v{run.version.version}</span>
          <span className="mono muted">{run.deployment.id}</span>
          <span className="mono muted">{run.trigger.kind}</span>
          <span className="mono muted">attempt {run.attempt}</span>
          <span className="mono muted">event {run.rollup.computedThroughSequence}</span>
        </div>

        {actionError && <Notice tone="danger">{actionError}</Notice>}
        {actionNotice && <Notice tone="good">{actionNotice}</Notice>}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
            gap: 10,
            marginBottom: 16,
          }}
        >
          <SummaryCard
            label="Live state"
            value={run.status.replaceAll("_", " ")}
            detail={run.terminalReason ?? `revision ${run.revision}`}
          />
          <SummaryCard
            label="Provider cost"
            value={formatMoney(run.rollup.providers.costUsd)}
            detail={`${run.rollup.providers.calls} calls`}
          />
          <SummaryCard
            label="Tool effects"
            value={`${run.rollup.effects.succeeded}/${run.rollup.effects.total}`}
            detail={`${run.rollup.tools.denied} denied`}
          />
          <SummaryCard
            label="Evidence"
            value={String(run.rollup.evidenceEntries)}
            detail={`${run.rollup.events} events`}
          />
          <SummaryCard
            label="Artifacts"
            value={String(run.rollup.artifacts.count)}
            detail={formatBytes(run.rollup.artifacts.totalBytes)}
          />
          <SummaryCard
            label="Source gaps"
            value={String(run.rollup.sourceGaps.unexplained)}
            detail={`${run.rollup.sourceGaps.retentionDeleted} retention-deleted`}
          />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Section title="Objective" meta={`version ${run.version.version}`}>
              <p style={{ margin: 0, lineHeight: 1.65 }}>{run.version.objective}</p>
              <MetadataLine label="Definition" value={run.definition.id} />
              <MetadataLine label="Version digest" value={run.version.contentDigest} />
              <MetadataLine label="Deployment" value={run.deployment.id} />
              <MetadataLine label="Deployment state" value={run.deployment.status} />
            </Section>

            <Section title="Bounded budget" meta="reported usage / hard limit">
              <BudgetPanel usage={run.budget.usage} policy={run.budget.policy} />
            </Section>

            <Section
              title="Evidence timeline"
              meta={`${detail.data.evidence.items.length} visible`}
            >
              <EvidenceTimeline detail={detail.data} />
            </Section>
          </div>

          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Section
              title="Latest checkpoint"
              meta={run.latestCheckpoint ? `sequence ${run.latestCheckpoint.sequence}` : "none"}
            >
              {run.latestCheckpoint ? (
                <div>
                  <MetadataLine label="Checkpoint" value={run.latestCheckpoint.id} />
                  <MetadataLine label="Phase" value={run.latestCheckpoint.cursor.phase} />
                  <MetadataLine
                    label="Cursor"
                    value={`iteration ${run.latestCheckpoint.cursor.iteration}, action ${run.latestCheckpoint.cursor.actionIndex}`}
                  />
                  <MetadataLine
                    label="Created"
                    value={formatTimestamp(run.latestCheckpoint.createdAt)}
                  />
                  <MetadataLine label="State digest" value={run.latestCheckpoint.stateDigest} />
                </div>
              ) : (
                <EmptyState>No durable checkpoint has been recorded for this run.</EmptyState>
              )}
            </Section>

            <Section
              title="Operator attention"
              meta={`${run.attention.open} open · ${run.attention.total} total`}
            >
              <AttentionPanel
                attention={detail.data.attention}
                busy={busy}
                onResolve={resolveAttention}
              />
            </Section>

            <Section title="Artifacts" meta={`${detail.data.artifacts.items.length} visible`}>
              <ArtifactPanel artifacts={detail.data.artifacts.items} />
            </Section>

            <Section title="Event journal" meta={`${detail.data.events.items.length} visible`}>
              <EventTimeline detail={detail.data} />
            </Section>
          </aside>
        </div>
      </div>
    </>
  );
}

function ControlButton({
  label,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button className="top-btn" disabled={disabled} onClick={onClick}>
      {busy ? "Working…" : label}
    </button>
  );
}

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="card" style={{ padding: 18, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h2 className="kicker" style={{ margin: 0 }}>
          {title}
        </h2>
        {meta && (
          <div className="mono muted" style={{ fontSize: 10.5, marginLeft: "auto" }}>
            {meta}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="card" style={{ padding: 14, minWidth: 0 }}>
      <div className="kicker">{label}</div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 500,
          marginTop: 5,
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
      {detail && (
        <div className="mono muted" style={{ fontSize: 10.5, marginTop: 2 }}>
          {detail}
        </div>
      )}
    </div>
  );
}

function WorkerStatus({ status }: { status: WorkerRunStatus }) {
  const tone =
    status === "completed"
      ? "good"
      : ["failed", "budget_exhausted", "quarantined"].includes(status)
        ? "danger"
        : ["waiting_for_approval", "paused"].includes(status)
          ? "warn"
          : status === "running"
            ? "info"
            : "muted";
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {status.replaceAll("_", " ")}
    </span>
  );
}

function BudgetPanel({ usage, policy }: { usage: WorkerBudgetUsage; policy: WorkerBudgetPolicy }) {
  const rows = [
    ["Elapsed time", usage.elapsedMs, policy.maxElapsedMs, formatDuration],
    ["Iterations", usage.iterations, policy.maxIterations, formatCount],
    ["Provider cost", usage.providerCostUsd, policy.maxProviderCostUsd, formatMoney],
    ["Tool calls", usage.toolCalls, policy.maxToolCalls, formatCount],
    ["Consecutive failures", usage.consecutiveFailures, policy.maxConsecutiveFailures, formatCount],
  ] as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {rows.map(([label, value, maximum, formatter]) => {
        const percent =
          maximum <= 0 ? (value > 0 ? 100 : 0) : Math.min((value / maximum) * 100, 100);
        return (
          <div key={label}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>{label}</span>
              <span className="mono muted">
                {formatter(value)} / {formatter(maximum)}
              </span>
            </div>
            <div
              aria-label={`${label}: ${percent.toFixed(0)} percent used`}
              style={{
                height: 5,
                marginTop: 5,
                borderRadius: 3,
                background: "var(--line-2)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${percent}%`,
                  height: "100%",
                  background: percent >= 90 ? "var(--danger)" : "var(--green)",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AttentionPanel({
  attention,
  busy,
  onResolve,
}: {
  attention: WorkerAttentionView[];
  busy: string | null;
  onResolve: (attention: WorkerAttentionView, action: AttentionAction) => Promise<void>;
}) {
  if (attention.length === 0) {
    return <EmptyState>No operator attention has been requested.</EmptyState>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {attention.map((item) => (
        <div key={item.id} style={{ borderTop: "1px solid var(--line-2)", paddingTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span className={`pill ${item.status === "open" ? "warn" : "muted"}`}>
              {item.status}
            </span>
            <span className="mono">{item.operation?.tool ?? item.capabilityId}</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
            {item.operation
              ? `${item.operation.verb} · ${item.operation.effect} · ${item.operation.resourceCount} resource(s)`
              : `Capability ${item.capabilityId}`}
          </div>
          <div className="mono muted" style={{ fontSize: 10, marginTop: 3 }}>
            expires {formatTimestamp(item.expiresAt)}
          </div>
          {item.status === "open" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
              <button
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() => void onResolve(item, "approve-once")}
              >
                {busy === `${item.id}:approve-once` ? "Approving…" : "Approve once"}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() => void onResolve(item, "approve-for-run")}
              >
                {busy === `${item.id}:approve-for-run` ? "Approving…" : "Approve for run"}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() => void onResolve(item, "reject")}
              >
                {busy === `${item.id}:reject` ? "Rejecting…" : "Reject"}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function EvidenceTimeline({ detail }: { detail: WorkerRunDetail }) {
  const items = useMemo(
    () => [...detail.evidence.items].sort((left, right) => right.sequence - left.sequence),
    [detail.evidence.items],
  );
  if (items.length === 0) return <EmptyState>No evidence entries are visible.</EmptyState>;
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((entry) => (
        <li
          key={entry.id}
          style={{
            display: "grid",
            gridTemplateColumns: "62px minmax(0, 1fr)",
            gap: 10,
            padding: "10px 0",
            borderTop: "1px solid var(--line-2)",
          }}
        >
          <div className="mono muted">#{entry.sequence}</div>
          <div style={{ minWidth: 0 }}>
            <div>{entry.summary}</div>
            <div className="mono muted" style={{ fontSize: 10.5, marginTop: 4 }}>
              {entry.classification} ·{" "}
              {entry.sourceReferences.map((source) => source.kind).join(", ")}
            </div>
            <div
              className="mono muted"
              title={entry.evidenceDigest}
              style={{ fontSize: 10, marginTop: 3, overflowWrap: "anywhere" }}
            >
              {shortDigest(entry.evidenceDigest)}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function EventTimeline({ detail }: { detail: WorkerRunDetail }) {
  const items = [...detail.events.items].sort((left, right) => right.sequence - left.sequence);
  if (items.length === 0) return <EmptyState>No Worker events are visible.</EmptyState>;
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((event) => (
        <li key={event.id} style={{ padding: "9px 0", borderTop: "1px solid var(--line-2)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span className="mono muted">#{event.sequence}</span>
            <span className="mono" style={{ fontSize: 11 }}>
              {event.type}
            </span>
          </div>
          <div style={{ marginTop: 4, lineHeight: 1.5 }}>{event.summary}</div>
          <div className="mono muted" style={{ fontSize: 10, marginTop: 3 }}>
            {event.source ?? "legacy"} · {formatTimestamp(event.occurredAt)}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ArtifactPanel({ artifacts }: { artifacts: WorkerRunDetail["artifacts"]["items"] }) {
  if (artifacts.length === 0) {
    return <EmptyState>No artifact manifests are linked to this run.</EmptyState>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {artifacts.map((manifest) => (
        <div key={manifest.id} style={{ borderTop: "1px solid var(--line-2)", paddingTop: 10 }}>
          <div>{manifest.artifact.name ?? manifest.artifact.mediaType}</div>
          <div className="mono muted" style={{ fontSize: 10.5, marginTop: 3 }}>
            {formatBytes(manifest.artifact.byteLength)} · {manifest.classification} ·{" "}
            {manifest.provenance.producerKind}
          </div>
          <div
            className="mono muted"
            title={manifest.artifact.reference}
            style={{ fontSize: 10, marginTop: 3, overflowWrap: "anywhere" }}
          >
            {manifest.artifact.reference}
          </div>
        </div>
      ))}
    </div>
  );
}

function MetadataLine({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "125px minmax(0, 1fr)",
        gap: 10,
        marginTop: 9,
      }}
    >
      <span className="muted">{label}</span>
      <span className="mono" style={{ overflowWrap: "anywhere" }}>
        {value}
      </span>
    </div>
  );
}

function Notice({ tone, children }: { tone: "good" | "danger"; children: ReactNode }) {
  return (
    <div
      className="card"
      role={tone === "danger" ? "alert" : "status"}
      style={{
        padding: "12px 14px",
        marginBottom: 14,
        color: tone === "danger" ? "var(--danger)" : "var(--green)",
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="muted" style={{ padding: "8px 0", lineHeight: 1.55 }}>
      {children}
    </div>
  );
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function formatCount(value: number): string {
  return String(value);
}

function formatMoney(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function shortDigest(value: string): string {
  return value.length > 24 ? `${value.slice(0, 20)}…` : value;
}
