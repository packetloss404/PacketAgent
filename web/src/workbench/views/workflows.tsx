import { useState, type ReactNode } from "react";
import { I } from "../icons";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";

type WfTab = "brief" | "requirements" | "plan" | "blockers" | "validation" | "release";

export function WorkflowsView() {
  const [tab, setTab] = useState<WfTab>("brief");

  const requirements = useApiData(() => api.listWorkflowRequirements(), []);
  const planItems = useApiData(() => api.listWorkflowPlanItems(), []);
  const blockers = useApiData(() => api.listWorkflowBlockers(), []);
  const questions = useApiData(() => api.listWorkflowQuestions(), []);
  const validation = useApiData(() => api.listWorkflowValidationEvidence(), []);

  return (
    <>
      <div role="tablist" aria-label="Workflow sections" className="wf-subtabs">
        {(
          [
            { id: "brief", label: "Brief" },
            { id: "requirements", label: "Requirements", count: requirements.data?.length },
            { id: "plan", label: "Plan", count: planItems.data?.length },
            {
              id: "blockers",
              label: "Blockers · Questions",
              count: (blockers.data?.length ?? 0) + (questions.data?.length ?? 0),
            },
            { id: "validation", label: "Validation", count: validation.data?.length },
            { id: "release", label: "Release" },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            className={`wf-subtab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id as WfTab)}
          >
            {t.label}
            {"count" in t && t.count !== undefined && (
              <span className="wf-subtab-count">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      <div style={{ padding: "20px 28px 26px", maxWidth: 1100 }}>
        {tab === "brief" && <BriefView />}
        {tab === "requirements" && (
          <RequirementsView data={requirements.data} loading={requirements.loading} />
        )}
        {tab === "plan" && <PlanView data={planItems.data} loading={planItems.loading} />}
        {tab === "blockers" && (
          <BlockersView
            blockers={blockers.data}
            questions={questions.data}
            loading={blockers.loading || questions.loading}
          />
        )}
        {tab === "validation" && (
          <ValidationView data={validation.data} loading={validation.loading} />
        )}
        {tab === "release" && <ReleaseView />}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="kicker" style={{ marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function BriefView() {
  const brief = useApiData(() => api.getWorkflowBrief().catch(() => null), []);
  const data = brief.data;

  return (
    <div>
      <div className="kicker">BRIEF</div>
      <h2 className="h2" style={{ fontSize: 22, marginTop: 4, marginBottom: 18 }}>
        {data?.summary ? data.summary.slice(0, 80) : "Workflow brief"}
      </h2>
      {brief.loading && <div className="muted">Loading…</div>}
      {!brief.loading && !data && (
        <div className="card muted" style={{ padding: 22 }}>
          No workflow brief saved yet. Generate one from a prompt to populate this view.
        </div>
      )}
      {data && (
        <div className="card" style={{ padding: 20 }}>
          <Section title="Summary">
            <p style={{ fontSize: 14, lineHeight: 1.6 }}>{data.summary}</p>
          </Section>
          {data.goals && data.goals.length > 0 && (
            <Section title="Goals">
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.8 }}>
                {data.goals.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </Section>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            {data.audience && (
              <Section title="Audience">
                <p style={{ fontSize: 13.5 }}>{data.audience}</p>
              </Section>
            )}
            {data.constraints && (
              <Section title="Constraints">
                <p style={{ fontSize: 13.5 }}>{data.constraints}</p>
              </Section>
            )}
          </div>
          {data.successMetrics && data.successMetrics.length > 0 && (
            <Section title="Success metrics">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {data.successMetrics.map((m, i) => (
                  <div key={i} className="card" style={{ padding: 10, fontSize: 12.5 }}>
                    {m}
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function RequirementsView({
  data,
  loading,
}: {
  data: ReadonlyArray<{ id: string; title: string; priority: string; status: string }> | null;
  loading: boolean;
}) {
  const list = data ?? [];
  return (
    <div>
      <h2 className="h2" style={{ fontSize: 20, marginBottom: 14 }}>
        Requirements
      </h2>
      {loading && <div className="muted">Loading…</div>}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Title</th>
              <th>Priority</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td style={{ color: "var(--silver-50)" }}>{r.title}</td>
                <td>
                  <span
                    className={`pill ${r.priority === "must" ? "good" : r.priority === "should" ? "info" : "muted"}`}
                  >
                    {r.priority}
                  </span>
                </td>
                <td>
                  <span
                    className={`pill ${r.status === "accepted" ? "good" : r.status === "deferred" ? "warn" : "muted"}`}
                  >
                    <span className="dot"></span>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
            {list.length === 0 && !loading && (
              <tr>
                <td colSpan={3} className="muted" style={{ padding: 18, textAlign: "center" }}>
                  No requirements yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanView({
  data,
  loading,
}: {
  data: ReadonlyArray<{ id: string; title: string; status: string; owner?: string }> | null;
  loading: boolean;
}) {
  const list = data ?? [];
  const done = list.filter((p) => p.status === "done").length;
  const inProg = list.filter((p) => p.status === "in_progress").length;
  const todo = list.filter((p) => p.status === "todo").length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 14 }}>
        <h2 className="h2" style={{ fontSize: 20 }}>
          Plan
        </h2>
        <span className="muted" style={{ marginLeft: 10, fontSize: 13 }}>
          {done} done · {inProg} in progress · {todo} todo
        </span>
        <span className="pill muted" style={{ marginLeft: "auto" }}>
          <I.sparkle size={11} /> Read-only plan
        </span>
      </div>
      {loading && <div className="muted">Loading…</div>}
      {list.map((p) => (
        <div
          key={p.id}
          className="card"
          style={{ padding: 14, marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}
        >
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              background: p.status === "done" ? "var(--green)" : "transparent",
              border: `1px solid ${p.status === "done" ? "var(--green)" : "var(--line-3)"}`,
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            {p.status === "done" && <I.check size={11} stroke="#0E1A02" strokeWidth={3} />}
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 13.5,
                color: p.status === "done" ? "var(--silver-400)" : "var(--silver-50)",
                textDecoration: p.status === "done" ? "line-through" : "none",
              }}
            >
              {p.title}
            </div>
            {p.owner && (
              <div className="mono muted" style={{ fontSize: 11 }}>
                owner: {p.owner}
              </div>
            )}
          </div>
          <span
            className={`pill ${p.status === "done" ? "good" : p.status === "in_progress" ? "info" : "muted"}`}
          >
            <span className="dot"></span>
            {p.status.replace("_", " ")}
          </span>
        </div>
      ))}
      {list.length === 0 && !loading && (
        <div className="card muted" style={{ padding: 16 }}>
          No plan items yet.
        </div>
      )}
    </div>
  );
}

function BlockersView({
  blockers,
  questions,
  loading,
}: {
  blockers: ReadonlyArray<{ id: string; title: string; severity: string; status: string }> | null;
  questions: ReadonlyArray<{ id: string; prompt: string; status: string; answer: string }> | null;
  loading: boolean;
}) {
  const bList = blockers ?? [];
  const qList = questions ?? [];
  return (
    <div>
      <h2 className="h2" style={{ fontSize: 20, marginBottom: 14 }}>
        Blockers · Open questions
      </h2>
      {loading && <div className="muted">Loading…</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>
            BLOCKERS · {bList.length}
          </div>
          {bList.map((b) => (
            <div key={b.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <I.alert
                  size={14}
                  style={{
                    color:
                      b.severity === "high"
                        ? "var(--danger)"
                        : b.severity === "medium"
                          ? "var(--warn)"
                          : "var(--silver-400)",
                  }}
                />
                <div style={{ flex: 1, fontSize: 13.5, fontWeight: 500 }}>{b.title}</div>
                <span className={`pill ${b.status === "open" ? "warn" : "good"}`}>
                  <span className="dot"></span>
                  {b.status}
                </span>
              </div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                severity: {b.severity}
              </div>
            </div>
          ))}
          {bList.length === 0 && !loading && (
            <div className="card muted" style={{ padding: 12 }}>
              No blockers.
            </div>
          )}
        </div>
        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>
            QUESTIONS · {qList.length}
          </div>
          {qList.map((q) => (
            <div key={q.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  className="serif"
                  style={{ fontSize: 18, color: "var(--green)", lineHeight: 1 }}
                >
                  ?
                </span>
                <div style={{ flex: 1, fontSize: 13.5 }}>{q.prompt}</div>
                <span className={`pill ${q.status === "open" ? "warn" : "good"}`}>
                  <span className="dot"></span>
                  {q.status}
                </span>
              </div>
              {q.answer && q.answer.trim() && (
                <div className="muted" style={{ fontSize: 12.5, marginTop: 6, paddingLeft: 22 }}>
                  {q.answer}
                </div>
              )}
            </div>
          ))}
          {qList.length === 0 && !loading && (
            <div className="card muted" style={{ padding: 12 }}>
              No open questions.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ValidationView({
  data,
  loading,
}: {
  data: ReadonlyArray<{ id: string; title: string; status: string; source?: string | null }> | null;
  loading: boolean;
}) {
  const list = data ?? [];
  return (
    <div>
      <h2 className="h2" style={{ fontSize: 20, marginBottom: 14 }}>
        Validation evidence
      </h2>
      {loading && <div className="muted">Loading…</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
        {list.map((v) => (
          <div key={v.id} className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <I.shield
                size={14}
                style={{
                  color:
                    v.status === "passed"
                      ? "var(--green)"
                      : v.status === "failed"
                        ? "var(--danger)"
                        : "var(--silver-400)",
                }}
              />
              <div style={{ flex: 1, fontSize: 13.5, fontWeight: 500 }}>{v.title}</div>
              <span
                className={`pill ${v.status === "passed" ? "good" : v.status === "failed" ? "danger" : "muted"}`}
              >
                <span className="dot"></span>
                {v.status}
              </span>
            </div>
            {v.source && (
              <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                source: {v.source}
              </div>
            )}
          </div>
        ))}
        {list.length === 0 && !loading && (
          <div className="card muted" style={{ padding: 14 }}>
            No validation evidence yet.
          </div>
        )}
      </div>
    </div>
  );
}

function ReleaseView() {
  const release = useApiData(() => api.getWorkflowReleaseConfirmation().catch(() => null), []);
  const r = release.data;
  return (
    <div>
      <h2 className="h2" style={{ fontSize: 20, marginBottom: 14 }}>
        Release readiness
      </h2>
      {release.loading && <div className="muted">Loading…</div>}
      {r && (
        <div className="card" style={{ padding: 22, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <I.rocket size={22} style={{ color: r.confirmed ? "var(--green)" : "var(--warn)" }} />
            <div style={{ flex: 1 }}>
              <div className="h2">{r.confirmed ? "Confirmed" : "Awaiting confirmation"}</div>
              <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {r.summary || "—"}
              </p>
            </div>
            {!r.confirmed && (
              <button
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    await api.confirmWorkflowRelease({ confirmed: true, summary: r.summary ?? "" });
                    await release.refresh();
                  } catch (e) {
                    console.error(e);
                  }
                }}
              >
                <I.rocket size={13} /> Confirm release
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
