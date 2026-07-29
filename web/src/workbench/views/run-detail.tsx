import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { I } from "../icons";
import { Topbar } from "../Shell";
import { api } from "@/lib/api";
import type {
  ActivityDetailPayload,
  ActivityRecord,
  ActivityWorkflowContext,
  AgentRecord,
  AgentRunRecord,
} from "@/lib/types";
import { RunTranscript, ToolCallTimeline } from "./agent-editor";

export function RunDetailView() {
  const { id = "" } = useParams();
  return <RunDetailContent key={id} id={id} />;
}

function RunDetailContent({ id }: { id: string }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<ActivityDetailPayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [run, setRun] = useState<AgentRunRecord | null>(null);

  useEffect(() => {
    let mounted = true;
    void api
      .getActivityDetail(id)
      .then((d) => {
        if (!mounted) return;
        setDetail(d);
        const ar = d.related?.run ?? d.run;
        if (ar?.id) {
          // Fetch the parent agent to get full run record (for transcript/toolcalls/output)
          if (ar.agentId) {
            void api
              .getAgent(ar.agentId)
              .then((agentDetail) => {
                if (!mounted) return;
                const full = agentDetail.runs.find((r) => r.id === ar.id);
                if (full) setRun(full);
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => mounted && setNotFound(true));
    return () => {
      mounted = false;
    };
  }, [id]);

  if (notFound) {
    return (
      <>
        <Topbar crumbs={["__WS__", "Activity"]} />
        <div style={{ padding: "26px 28px" }}>
          <button type="button" className="btn btn-sm" onClick={() => navigate(-1)}>
            <I.arrow size={11} style={{ transform: "scaleX(-1)" }} /> Back
          </button>
          <div className="card muted" style={{ padding: 22, marginTop: 18 }}>
            Activity not found.
          </div>
        </div>
      </>
    );
  }
  if (!detail) {
    return (
      <>
        <Topbar crumbs={["__WS__", "Activity"]} />
        <div className="muted" style={{ padding: 26 }}>
          Loading activity detail…
        </div>
      </>
    );
  }

  const activity = detail.activity;
  const actorName = activity.actor?.displayName || activity.actor?.id || "System";
  const relatedAgent = detail.related?.agent ?? detail.agent ?? null;
  const relatedRun = detail.related?.run ?? detail.run ?? null;
  const relatedWorkflow = detail.related?.workflow ?? detail.workflow ?? null;

  return (
    <>
      <Topbar
        crumbs={["__WS__", "Activity", activityTitle(activity)]}
        actions={
          <button type="button" className="top-btn" onClick={() => navigate("/runs")}>
            <I.activity size={13} /> All activity
          </button>
        }
      />
      <div style={{ padding: "26px 28px 60px", maxWidth: 1200 }}>
        <div className="kicker">CONTROL ROOM · ACTIVITY DETAIL</div>
        <h1 className="h1" style={{ fontSize: 28, marginTop: 4, marginBottom: 6 }}>
          {activityTitle(activity)}
        </h1>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
          {sentenceCase(activity.event)} event captured for the {activity.scope} scope.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 10,
            marginBottom: 18,
          }}
        >
          <SignalCard
            label="When"
            value={relativeTime(activity.occurredAt)}
            detail={activity.occurredAt}
          />
          <SignalCard label="Actor" value={actorName} detail={activity.actor?.type || "unknown"} />
          <SignalCard label="Activity ID" value={activity.id} detail="Trace reference" mono />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.15fr 0.85fr", gap: 18 }}>
          <main style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {run && (
              <>
                {run.transcript && run.transcript.length > 0 && (
                  <div className="card" style={{ padding: 18 }}>
                    <div className="kicker" style={{ marginBottom: 8 }}>
                      TRANSCRIPT · {run.transcript.length} STEP
                      {run.transcript.length === 1 ? "" : "S"}
                    </div>
                    <RunTranscript steps={run.transcript} />
                  </div>
                )}
                {run.toolCalls && run.toolCalls.length > 0 && (
                  <div className="card" style={{ padding: 18 }}>
                    <div className="kicker" style={{ marginBottom: 8 }}>
                      TOOL CALLS · {run.toolCalls.length}
                    </div>
                    <ToolCallTimeline calls={run.toolCalls} />
                  </div>
                )}
                {run.output && (
                  <div className="card" style={{ padding: 18 }}>
                    <div className="kicker" style={{ marginBottom: 8 }}>
                      OUTPUT
                    </div>
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
                      }}
                    >
                      {run.output}
                    </pre>
                  </div>
                )}
                {run.logs && run.logs.length > 0 && (
                  <div className="card" style={{ padding: 18 }}>
                    <div className="kicker" style={{ marginBottom: 8 }}>
                      LOGS
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {run.logs.map((entry, i) => (
                        <div
                          key={i}
                          className="mono"
                          style={{ fontSize: 11.5, display: "flex", gap: 8 }}
                        >
                          <span
                            style={{
                              color:
                                entry.level === "error"
                                  ? "var(--danger)"
                                  : entry.level === "warn"
                                    ? "var(--warn)"
                                    : "var(--silver-500)",
                              width: 50,
                            }}
                          >
                            {entry.level.toUpperCase()}
                          </span>
                          <span style={{ color: "var(--silver-200)" }}>{entry.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="card" style={{ padding: 18 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <div className="kicker">DECODED DATA</div>
                <span className="mono muted" style={{ fontSize: 10.5 }}>
                  {dataEntries(activity).length} fields
                </span>
              </div>
              <DecodedData activity={activity} />
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div className="kicker" style={{ marginBottom: 6 }}>
                RAW PAYLOAD
              </div>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--silver-200)" }}>
                  Show JSON payload
                </summary>
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    marginTop: 10,
                    padding: 12,
                    fontSize: 11,
                    lineHeight: 1.6,
                    background: "var(--ink)",
                    border: "1px solid var(--line)",
                    borderRadius: 6,
                    color: "var(--silver-200)",
                    maxHeight: 400,
                    overflow: "auto",
                  }}
                >
                  {JSON.stringify(activity.data ?? {}, null, 2)}
                </pre>
              </details>
            </div>
          </main>

          <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="card" style={{ padding: 18 }}>
              <div className="kicker" style={{ marginBottom: 8 }}>
                TIMELINE NAVIGATION
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                <TimelineLink label="Previous" activity={detail.previous} direction="back" />
                <TimelineLink label="Next" activity={detail.next} direction="forward" />
              </div>
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div className="kicker" style={{ marginBottom: 8 }}>
                RELATED CONTEXT
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {relatedAgent && <AgentPanel agent={relatedAgent} />}
                {relatedRun && <RunPanel run={relatedRun} />}
                {relatedWorkflow && <WorkflowPanel workflow={relatedWorkflow} />}
                {!relatedAgent && !relatedRun && !relatedWorkflow && (
                  <div className="card muted" style={{ padding: 12, fontSize: 12 }}>
                    No related agent, run, or workflow context for this event.
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function SignalCard({
  label,
  value,
  detail,
  mono,
}: {
  label: string;
  value: string;
  detail?: string;
  mono?: boolean;
}) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="kicker">{label}</div>
      <div
        style={{
          marginTop: 6,
          fontSize: 14,
          color: "var(--silver-50)",
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          wordBreak: "break-all",
        }}
      >
        {value}
      </div>
      {detail && (
        <div
          className="mono muted"
          style={{ fontSize: 10.5, marginTop: 4, wordBreak: "break-all" }}
        >
          {detail}
        </div>
      )}
    </div>
  );
}

function DecodedData({ activity }: { activity: ActivityRecord }) {
  const entries = dataEntries(activity);
  if (entries.length === 0)
    return (
      <div className="card muted" style={{ padding: 12, fontSize: 12 }}>
        No event data fields were provided.
      </div>
    );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 8 }}>
      {entries.map(([key, value]) => (
        <div key={key} className="card" style={{ padding: 10, background: "var(--bg-elev)" }}>
          <div className="kicker" style={{ fontSize: 9.5 }}>
            {labelize(key)}
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: "var(--silver-200)",
              wordBreak: "break-word",
            }}
          >
            {renderValue(value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function TimelineLink({
  label,
  activity,
  direction,
}: {
  label: string;
  activity: ActivityRecord | null | undefined;
  direction: "back" | "forward";
}) {
  if (!activity) {
    return (
      <div className="card muted" style={{ padding: 10, fontSize: 12 }}>
        <div className="kicker" style={{ fontSize: 9.5 }}>
          {label}
        </div>
        <div style={{ marginTop: 4 }}>No {direction === "back" ? "earlier" : "later"} event.</div>
      </div>
    );
  }
  return (
    <Link to={`/activity/${activity.id}`} style={{ textDecoration: "none", color: "inherit" }}>
      <div className="card" style={{ padding: 10, cursor: "pointer" }}>
        <div className="kicker" style={{ fontSize: 9.5 }}>
          {label}
        </div>
        <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--silver-50)", fontWeight: 500 }}>
          {activityTitle(activity)}
        </div>
        <div className="mono muted" style={{ fontSize: 10.5, marginTop: 2 }}>
          {relativeTime(activity.occurredAt)} · {activity.event}
        </div>
      </div>
    </Link>
  );
}

function AgentPanel({ agent }: { agent: Partial<AgentRecord> }) {
  return (
    <ContextPanel
      label="Agent"
      title={stringValue(agent.name) || "Related agent"}
      href={stringValue(agent.id) ? `/agents/${agent.id}` : "/agents"}
    >
      <MetaLine label="Status" value={stringValue(agent.status)} />
      <MetaLine label="Model" value={stringValue(agent.model)} />
      <MetaLine label="Updated" value={relativeTime(stringValue(agent.updatedAt))} />
    </ContextPanel>
  );
}

function RunPanel({ run }: { run: Partial<AgentRunRecord> }) {
  return (
    <ContextPanel label="Run" title={stringValue(run.title) || "Related run"} href="/runs">
      <MetaLine label="Status" value={stringValue(run.status)} />
      <MetaLine label="Trigger" value={stringValue(run.triggerKind)} />
      <MetaLine label="Created" value={relativeTime(stringValue(run.createdAt))} />
    </ContextPanel>
  );
}

function WorkflowPanel({ workflow }: { workflow: ActivityWorkflowContext }) {
  const counts = [
    countLabel(workflow.requirements, "requirement"),
    countLabel(workflow.planItems, "plan item"),
    countLabel(workflow.blockers, "blocker"),
    countLabel(workflow.questions, "question"),
  ].filter(Boolean) as string[];

  return (
    <ContextPanel
      label="Workflow"
      title={workflow.brief?.summary || "Workflow context"}
      href="/workflows"
    >
      <MetaLine label="Audience" value={workflow.brief?.audience} />
      <MetaLine label="Updated" value={relativeTime(stringValue(workflow.brief?.updatedAt))} />
      {counts.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 8 }}>
          {counts.map((count) => (
            <span key={count} className="pill muted" style={{ fontSize: 9.5 }}>
              {count}
            </span>
          ))}
        </div>
      )}
    </ContextPanel>
  );
}

function ContextPanel({
  label,
  title,
  href,
  children,
}: {
  label: string;
  title: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <div className="card" style={{ padding: 12, background: "var(--bg-elev)" }}>
      <div className="kicker" style={{ fontSize: 9.5 }}>
        {label}
      </div>
      <Link to={href} style={{ textDecoration: "none" }}>
        <div style={{ marginTop: 4, fontSize: 13, color: "var(--silver-50)", fontWeight: 500 }}>
          {title}
        </div>
      </Link>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
        {children}
      </div>
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value: unknown }) {
  const rendered = renderValue(value);
  if (rendered === "—") return null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11.5 }}>
      <span className="muted">{label}</span>
      <span style={{ color: "var(--silver-300)", textAlign: "right", wordBreak: "break-word" }}>
        {rendered}
      </span>
    </div>
  );
}

function activityTitle(activity: ActivityRecord): string {
  return (
    stringValue((activity.data as { title?: unknown } | undefined)?.title) ||
    stringValue((activity.data as { name?: unknown } | undefined)?.name) ||
    sentenceCase(activity.event)
  );
}

function dataEntries(activity: ActivityRecord): [string, unknown][] {
  return Object.entries(activity.data ?? {}).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : "—";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? value.map(renderValue).join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function labelize(key: string): string {
  return key
    .replace(/[_-]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function sentenceCase(value: string): string {
  return labelize(value).replace(/\b\w/g, (c, i) => (i === 0 ? c.toUpperCase() : c.toLowerCase()));
}

function countLabel(items: unknown[] | undefined, singular: string): string | null {
  if (!items?.length) return null;
  return `${items.length} ${singular}${items.length === 1 ? "" : "s"}`;
}

function relativeTime(iso: string | undefined | null): string {
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
