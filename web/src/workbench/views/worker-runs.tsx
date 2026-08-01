import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import type { WorkerOperationsHealth, WorkerRunStatus, WorkerRunSummary } from "@/lib/types";
import { Topbar } from "../Shell";
import { useApiData } from "../useApiData";
import { workerRunListAccessibleState } from "../worker-operations-state";
import { AsyncStateBoundary } from "@/components/AsyncStateBoundary";
import { formatMoney, formatRelativeTime, formatStatusLabel } from "@/lib/format";

const WORKER_STATUS_FILTERS: Array<"all" | WorkerRunStatus> = [
  "all",
  "running",
  "waiting_for_approval",
  "paused",
  "queued",
  "completed",
  "failed",
  "budget_exhausted",
  "cancelled",
  "quarantined",
];

export function WorkerRunsView() {
  const navigate = useNavigate();
  const onModeChange = (mode: "workers" | "agents") => {
    if (mode === "agents") navigate("/activity");
  };
  const [status, setStatus] = useState<"all" | WorkerRunStatus>("all");
  const [search, setSearch] = useState("");
  const [additionalRuns, setAdditionalRuns] = useState<WorkerRunSummary[]>([]);
  const [paginationCursor, setPaginationCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const health = useApiData(() => api.getWorkerOperationsHealth(), []);
  const firstPage = useApiData(
    () =>
      api.listWorkerRuns({
        ...(status === "all" ? {} : { status }),
        limit: 50,
      }),
    [status],
  );

  const loadedRuns = useMemo(
    () => [
      ...(firstPage.data?.runs ?? []),
      ...additionalRuns.filter(
        (candidate) => !firstPage.data?.runs.some((run) => run.id === candidate.id),
      ),
    ],
    [additionalRuns, firstPage.data],
  );
  const nextCursor =
    paginationCursor === null ? firstPage.data?.page.nextCursor : paginationCursor || undefined;

  const visibleRuns = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return loadedRuns;
    return loadedRuns.filter((run) =>
      [
        run.id,
        run.definition.name,
        run.definition.id,
        run.deployment.id,
        run.version.id,
        run.status,
      ].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [loadedRuns, search]);
  const accessibleState = workerRunListAccessibleState({
    loading: firstPage.loading,
    error: firstPage.error ?? health.error,
    visibleRuns: visibleRuns.length,
  });

  const refresh = () => {
    setAdditionalRuns([]);
    setPaginationCursor(null);
    setLoadMoreError(null);
    void firstPage.refresh();
    void health.refresh();
  };

  const selectStatus = (nextStatus: "all" | WorkerRunStatus) => {
    setStatus(nextStatus);
    setAdditionalRuns([]);
    setPaginationCursor(null);
    setLoadMoreError(null);
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await api.listWorkerRuns({
        ...(status === "all" ? {} : { status }),
        cursor: nextCursor,
        limit: 50,
      });
      setAdditionalRuns((current) => [
        ...current,
        ...page.runs.filter((candidate) => !current.some((run) => run.id === candidate.id)),
      ]);
      setPaginationCursor(page.page.nextCursor ?? "");
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <Topbar crumbs={["__WS__", "Runs", "Workers"]} />
      <div style={{ padding: "26px 28px 60px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 18,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div className="kicker">CANONICAL WORKER OPERATIONS</div>
            <h1 className="h1" style={{ fontSize: 28, marginTop: 4, marginBottom: 5 }}>
              Durable Workers
            </h1>
            <div className="muted" style={{ maxWidth: 720, fontSize: 12.5 }}>
              Live state, bounded budgets, checkpoints, attention, and evidence from one
              workspace-scoped read model.
            </div>
          </div>
          <RunModeSwitch mode="workers" onChange={onModeChange} />
        </div>

        <WorkerHealthCards health={health.data} loading={health.loading} />

        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span className="kicker">STATE</span>
          {WORKER_STATUS_FILTERS.map((filter) => (
            <button
              type="button"
              key={filter}
              className="btn btn-sm"
              aria-pressed={status === filter}
              onClick={() => selectStatus(filter)}
              style={{
                background: status === filter ? "var(--bg-elev)" : "var(--panel)",
                color: status === filter ? "var(--silver-50)" : "var(--silver-300)",
                borderColor: status === filter ? "var(--line-3)" : "var(--line-2)",
              }}
            >
              {workerStatusLabel(filter)}
            </button>
          ))}
          <label style={{ marginLeft: "auto" }}>
            <span className="sr-only">Search Workers</span>
            <input
              className="field"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search run, Worker, deployment…"
              style={{ width: 290 }}
            />
          </label>
          <button type="button" className="btn btn-sm" onClick={refresh}>
            Refresh
          </button>
        </div>

        {(accessibleState.kind === "error" || accessibleState.kind === "loading") && (
          <AsyncStateBoundary
            state={accessibleState}
            onRetry={refresh}
            retryLabel="Retry Workers"
          />
        )}

        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>State</th>
                <th>Worker</th>
                <th>Deployment</th>
                <th>Budget</th>
                <th>Checkpoint</th>
                <th>Attention</th>
                <th>Updated</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRuns.map((run) => (
                <tr key={run.id}>
                  <td>
                    <WorkerStatusPill status={run.status} />
                  </td>
                  <td style={{ minWidth: 210 }}>
                    <div style={{ color: "var(--silver-50)" }}>{run.definition.name}</div>
                    <div className="mono muted" style={{ fontSize: 10.5 }}>
                      {run.id}
                    </div>
                  </td>
                  <td style={{ minWidth: 150 }}>
                    <div className="mono">v{run.version.version}</div>
                    <div className="mono muted" style={{ fontSize: 10.5 }}>
                      {run.deployment.id}
                    </div>
                  </td>
                  <td style={{ minWidth: 145 }}>
                    <BudgetCompact run={run} />
                  </td>
                  <td>
                    {run.latestCheckpoint ? (
                      <>
                        <div>{run.latestCheckpoint.cursor.phase}</div>
                        <div className="mono muted" style={{ fontSize: 10.5 }}>
                          iter {run.latestCheckpoint.cursor.iteration} · seq{" "}
                          {run.latestCheckpoint.sequence}
                        </div>
                      </>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                  <td>
                    {run.attention.open > 0 ? (
                      <span className="pill warn">
                        <span className="dot" />
                        {run.attention.open} open
                      </span>
                    ) : (
                      <span className="muted">clear</span>
                    )}
                  </td>
                  <td className="mono">{formatRelativeTime(run.updatedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`View Worker run ${run.id}`}
                      onClick={() => navigate(`/runs/worker/${encodeURIComponent(run.id)}`)}
                    >
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
              {accessibleState.kind === "empty" && (
                <tr>
                  <td colSpan={8} className="muted" style={{ padding: 22, textAlign: "center" }}>
                    <AsyncStateBoundary state={accessibleState} inline />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loadMoreError && (
          <div role="alert" style={{ color: "var(--danger)", marginTop: 10 }}>
            {loadMoreError}
          </div>
        )}
        {nextCursor && (
          <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
            <button
              type="button"
              className="btn"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more Workers"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function RunModeSwitch({
  mode,
  onChange,
}: {
  mode: "workers" | "agents";
  onChange: (mode: "workers" | "agents") => void;
}) {
  return (
    <div role="group" aria-label="Run type" style={{ display: "flex", gap: 5 }}>
      <button
        type="button"
        className="btn btn-sm"
        aria-pressed={mode === "workers"}
        onClick={() => onChange("workers")}
        style={{
          background: mode === "workers" ? "var(--bg-elev)" : "var(--panel)",
          color: mode === "workers" ? "var(--silver-50)" : "var(--silver-300)",
        }}
      >
        Workers
      </button>
      <button
        type="button"
        className="btn btn-sm"
        aria-pressed={mode === "agents"}
        onClick={() => onChange("agents")}
        style={{
          background: mode === "agents" ? "var(--bg-elev)" : "var(--panel)",
          color: mode === "agents" ? "var(--silver-50)" : "var(--silver-300)",
        }}
      >
        Agent activity
      </button>
    </div>
  );
}

function WorkerHealthCards({
  health,
  loading,
}: {
  health: WorkerOperationsHealth | null;
  loading: boolean;
}) {
  const state = health?.state ?? (loading ? "loading" : "unknown");
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
        gap: 10,
        marginBottom: 18,
      }}
      aria-label="Worker health summary"
    >
      <Card
        label="Control-plane health"
        value={state}
        sub={health ? `through event ${health.computedThroughSequence}` : "reading snapshot"}
        tone={
          health?.state === "healthy"
            ? "good"
            : health?.state === "attention" || health?.state === "degraded"
              ? "danger"
              : "default"
        }
      />
      <Card
        label="Active runs"
        value={String(health?.totals.activeRuns ?? 0)}
        sub={`${health?.totals.runs ?? 0} total`}
      />
      <Card
        label="Open attention"
        value={String(health?.totals.openAttention ?? 0)}
        sub={(health?.totals.openAttention ?? 0) > 0 ? "operator decision needed" : "all clear"}
        tone={(health?.totals.openAttention ?? 0) > 0 ? "danger" : "good"}
      />
      <Card
        label="Provider cost"
        value={formatMoney(health?.providerCostUsd ?? 0)}
        sub={`${health?.billableToolCalls ?? 0} tool calls`}
      />
      <Card
        label="Unexplained gaps"
        value={String(health?.unexplainedSourceGaps ?? 0)}
        sub={
          (health?.unexplainedSourceGaps ?? 0) > 0
            ? "evidence requires review"
            : "journal accounted for"
        }
        tone={(health?.unexplainedSourceGaps ?? 0) > 0 ? "danger" : "good"}
      />
    </div>
  );
}

function WorkerStatusPill({ status }: { status: WorkerRunStatus }) {
  const tone =
    status === "completed"
      ? "good"
      : ["failed", "budget_exhausted", "quarantined"].includes(status)
        ? "danger"
        : status === "waiting_for_approval" || status === "paused"
          ? "warn"
          : status === "running"
            ? "info"
            : "muted";
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {workerStatusLabel(status)}
    </span>
  );
}

function BudgetCompact({ run }: { run: WorkerRunSummary }) {
  const usage = run.budget.usage;
  const policy = run.budget.policy;
  const pct = Math.max(
    budgetPercent(usage.elapsedMs, policy.maxElapsedMs),
    budgetPercent(usage.iterations, policy.maxIterations),
    budgetPercent(usage.providerCostUsd, policy.maxProviderCostUsd),
    budgetPercent(usage.toolCalls, policy.maxToolCalls),
  );
  return (
    <>
      <div className="mono">{pct.toFixed(0)}% max</div>
      <div className="muted" style={{ fontSize: 10.5 }}>
        {usage.iterations}/{policy.maxIterations} iter · {formatMoney(usage.providerCostUsd)}
      </div>
    </>
  );
}

function budgetPercent(value: number, maximum: number): number {
  if (maximum <= 0) return value > 0 ? 100 : 0;
  return Math.min((value / maximum) * 100, 100);
}

function workerStatusLabel(status: "all" | WorkerRunStatus): string {
  return formatStatusLabel(status);
}

function Card({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "good" | "danger";
}) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="kicker">{label}</div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 500,
          marginTop: 4,
          color:
            tone === "good"
              ? "var(--green)"
              : tone === "danger"
                ? "var(--danger)"
                : "var(--silver-50)",
        }}
      >
        {value}
      </div>
      {sub && (
        <div className="mono muted" style={{ fontSize: 11 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
