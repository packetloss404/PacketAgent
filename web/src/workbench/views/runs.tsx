import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Topbar } from "../Shell";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";
import type { AgentRunStatus } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

const STATUS_FILTERS: Array<"all" | AgentRunStatus> = [
  "all",
  "success",
  "failed",
  "running",
  "queued",
];

export function RunsView() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const runs = useApiData(() => api.listAgentRuns(), []);
  const usage = useApiData(() => api.getUsageSummary(), []);
  const [currentTime] = useState(Date.now);

  const list = runs.data ?? [];
  const filtered = filter === "all" ? list : list.filter((r) => r.status === filter);

  const runs24h = list.filter((r) => {
    const started = r.startedAt ?? r.createdAt;
    if (!started) return false;
    return currentTime - new Date(started).getTime() < 24 * 60 * 60 * 1000;
  });
  const success24h = runs24h.filter((r) => r.status === "success").length;
  const failed24h = runs24h.filter((r) => r.status === "failed").length;
  const finished24h = runs24h.filter(
    (r) => r.status === "success" || r.status === "failed" || r.status === "canceled",
  ).length;
  const successRate = finished24h > 0 ? (success24h / finished24h) * 100 : 0;

  const durations = runs24h
    .map((r) => r.durationMs)
    .filter((x): x is number => typeof x === "number" && x > 0)
    .sort((a, b) => a - b);
  const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : 0;
  const p95 =
    durations.length > 0
      ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]!
      : 0;

  // Hourly bins for sparkline
  const buckets = useMemo(() => {
    const arr: { ok: number; fail: number }[] = Array.from({ length: 24 }, () => ({
      ok: 0,
      fail: 0,
    }));
    for (const r of runs24h) {
      const started = r.startedAt ?? r.createdAt;
      if (!started) continue;
      const hoursAgo = Math.floor((currentTime - new Date(started).getTime()) / (60 * 60 * 1000));
      if (hoursAgo < 0 || hoursAgo >= 24) continue;
      const idx = 23 - hoursAgo;
      if (r.status === "success") arr[idx]!.ok += 1;
      else if (r.status === "failed") arr[idx]!.fail += 1;
    }
    return arr;
  }, [currentTime, runs24h]);

  return (
    <>
      <Topbar crumbs={["__WS__", "Runs / Activity"]} />
      <div style={{ padding: "26px 28px" }}>
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 16 }}>
          <div>
            <div className="kicker">RUNS · LAST 24H</div>
            <h1 className="h1" style={{ fontSize: 28, marginTop: 4 }}>
              Activity
            </h1>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: "auto" }}
            onClick={() => navigate("/runs")}
          >
            Canonical Workers
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 10,
            marginBottom: 18,
          }}
        >
          <Card
            label="Total runs · 24h"
            value={String(runs24h.length)}
            sub={`${list.length} all-time`}
          />
          <Card
            label="Success rate"
            value={`${successRate.toFixed(1)}%`}
            sub={`${success24h} / ${finished24h} finished`}
            tone={successRate >= 90 ? "good" : "default"}
          />
          <Card
            label="Median latency"
            value={median ? `${(median / 1000).toFixed(1)}s` : "—"}
            sub={p95 ? `p95 · ${(p95 / 1000).toFixed(1)}s` : ""}
          />
          <Card
            label="Failed"
            value={String(failed24h)}
            sub={failed24h > 0 ? "needs review" : "all clear"}
            tone={failed24h > 0 ? "danger" : "good"}
          />
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12 }}>
            <div className="kicker">RUNS · HOURLY · 24H</div>
            <div
              style={{ marginLeft: "auto", display: "flex", gap: 12, fontSize: 11.5 }}
              className="mono"
            >
              <span style={{ color: "var(--green)" }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    background: "var(--green)",
                    borderRadius: 2,
                    marginRight: 4,
                  }}
                ></span>
                success
              </span>
              <span style={{ color: "var(--danger)" }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    background: "var(--danger)",
                    borderRadius: 2,
                    marginRight: 4,
                  }}
                ></span>
                failed
              </span>
            </div>
          </div>
          <Sparkline buckets={buckets} />
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center" }}>
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
          <input
            className="field"
            placeholder="Search by run id, agent, error…"
            style={{ width: 280, marginLeft: "auto" }}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void runs.refresh();
              void usage.refresh();
            }}
          >
            Refresh
          </button>
        </div>

        {runs.loading && (
          <div className="muted" style={{ padding: 16 }}>
            Loading runs…
          </div>
        )}
        {runs.error && (
          <div className="card" style={{ padding: 16, color: "var(--danger)" }}>
            {runs.error}
          </div>
        )}
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Status</th>
                <th>Run</th>
                <th>Agent</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span
                      className={`pill ${r.status === "success" ? "good" : r.status === "failed" ? "danger" : r.status === "running" ? "info" : "muted"}`}
                    >
                      <span className="dot"></span>
                      {r.status}
                    </span>
                  </td>
                  <td className="mono" style={{ color: "var(--silver-50)" }}>
                    {r.id.slice(0, 16)}
                  </td>
                  <td>{r.title}</td>
                  <td>{formatRelativeTime(r.startedAt)}</td>
                  <td className="mono">
                    {r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="mono">
                    {typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(3)}` : "—"}
                  </td>
                  <td style={{ display: "flex", gap: 4 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: "3px 8px" }}
                      onClick={() => navigate(`/runs/${r.id}`)}
                    >
                      View
                    </button>
                    {r.canCancel && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: "3px 8px" }}
                        onClick={() => api.cancelAgentRun(r.id).then(() => runs.refresh())}
                      >
                        Cancel
                      </button>
                    )}
                    {r.canRetry && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: "3px 8px" }}
                        onClick={() => api.retryAgentRun(r.id).then(() => runs.refresh())}
                      >
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && !runs.loading && (
                <tr>
                  <td colSpan={7} className="muted" style={{ padding: 18, textAlign: "center" }}>
                    No runs match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
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

function Sparkline({ buckets }: { buckets: { ok: number; fail: number }[] }) {
  const totals = buckets.map((b) => b.ok + b.fail);
  const max = Math.max(1, ...totals);
  const w = 980,
    h = 90,
    pad = 6;
  const bw = (w - pad * 2) / buckets.length;

  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
    >
      {buckets.map((b, i) => {
        const total = b.ok + b.fail;
        const totalH = (total / max) * (h - 12);
        const failH = (b.fail / max) * (h - 12);
        const okH = totalH - failH;
        return (
          <g key={i}>
            <rect
              x={pad + i * bw + 1}
              y={h - totalH}
              width={bw - 2}
              height={okH}
              fill="var(--green-deep)"
              opacity="0.85"
            />
            {b.fail > 0 && (
              <rect
                x={pad + i * bw + 1}
                y={h - failH}
                width={bw - 2}
                height={failH}
                fill="var(--danger)"
              />
            )}
          </g>
        );
      })}
      <line x1="0" y1={h - 0.5} x2={w} y2={h - 0.5} stroke="var(--line-2)" />
    </svg>
  );
}
