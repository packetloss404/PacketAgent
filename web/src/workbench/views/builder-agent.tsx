import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import type {
  AgentBuilderApproveResult,
  AgentBuilderDraft,
  AgentInputField,
  AgentRecord,
  AgentRunRecord,
} from "@/lib/types";
import { I } from "../icons";
import {
  agentEditorPath,
  agentAuthoringLabel,
  coerceSampleValue,
  draftToolNames,
  firstRunReadinessTone,
  formatSampleValue,
  inputValueForField,
  providerReadinessTone,
  runStatusTone,
  safeJson,
  sampleInputIssuesForDraft,
  sampleInputsForDraft,
  toolReadinessTone,
  type AgentBuilderSampleInputIssue,
  type AgentBuilderSampleInputs,
  type ReadinessTone,
} from "./builder-agent-utils";

type BuilderMode = "empty" | "drafting" | "drafted" | "saving" | "saved";

export interface AgentBuilderPanelProps {
  initialPrompt?: string;
  embedded?: boolean;
  autoGenerate?: boolean;
  onAgentSaved?: (agent: AgentRecord, result: AgentBuilderApproveResult) => void;
}

export function AgentBuilderPanel({
  initialPrompt = "",
  embedded = false,
  autoGenerate = false,
  onAgentSaved,
}: AgentBuilderPanelProps) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<BuilderMode>("empty");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [draft, setDraft] = useState<AgentBuilderDraft | null>(null);
  const [sampleInputs, setSampleInputs] = useState<AgentBuilderSampleInputs>({});
  const [runPreview, setRunPreview] = useState(true);
  const [savedAgent, setSavedAgent] = useState<AgentRecord | null>(null);
  const [firstRun, setFirstRun] = useState<AgentRunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoGenerateStarted = useRef(false);

  const working = mode === "drafting" || mode === "saving";
  const schemaByKey = useMemo(() => {
    const map = new Map<string, AgentInputField>();
    for (const field of draft?.agent.inputSchema ?? []) map.set(field.key, field);
    return map;
  }, [draft]);
  const sampleInputIssues = useMemo(
    () => (draft ? sampleInputIssuesForDraft(draft, sampleInputs) : []),
    [draft, sampleInputs],
  );

  const generateDraft = useCallback(async () => {
    if (!prompt.trim() || working) return;
    setError(null);
    setSavedAgent(null);
    setFirstRun(null);
    setMode("drafting");
    try {
      const nextDraft = await api.generateAgentBuilderDraft({ prompt: prompt.trim() });
      const nextSampleInputs = sampleInputsForDraft(nextDraft);
      setDraft(nextDraft);
      setSampleInputs(nextSampleInputs);
      setRunPreview(
        nextDraft.readiness.firstRun.canRun &&
          sampleInputIssuesForDraft(nextDraft, nextSampleInputs).length === 0,
      );
      setMode("drafted");
    } catch (e) {
      setError((e as Error).message);
      setMode(draft ? "drafted" : "empty");
    }
  }, [draft, prompt, working]);

  useEffect(() => {
    if (
      !autoGenerate ||
      autoGenerateStarted.current ||
      !prompt.trim() ||
      working ||
      draft ||
      savedAgent
    )
      return;
    autoGenerateStarted.current = true;
    void generateDraft();
  }, [autoGenerate, draft, generateDraft, prompt, savedAgent, working]);

  const approveDraft = async () => {
    if (!draft || working) return;
    setError(null);
    setMode("saving");
    try {
      const result = await api.approveAgentBuilderDraft({
        prompt: prompt.trim() || draft.prompt,
        draft,
        status: "active",
        runPreview: runPreview && draft.readiness.firstRun.canRun && sampleInputIssues.length === 0,
        sampleInputs,
      });
      setDraft(result.draft);
      setSampleInputs(
        (result.sampleInputs as AgentBuilderSampleInputs | undefined) ??
          sampleInputsForDraft(result.draft),
      );
      setSavedAgent(result.agent ?? null);
      setFirstRun(result.firstRun ?? null);
      if (result.agent) onAgentSaved?.(result.agent, result);
      setMode("saved");
    } catch (e) {
      setError((e as Error).message);
      setMode("drafted");
    }
  };

  const updateSample = (key: string, value: string | boolean) => {
    const field = schemaByKey.get(key);
    setSampleInputs((prev) => ({ ...prev, [key]: coerceSampleValue(field, value) }));
  };

  return (
    <div
      style={{
        minHeight: embedded ? undefined : "calc(100vh - 52px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {!embedded && (
        <div
          style={{
            padding: "22px 28px",
            borderBottom: "1px solid var(--line)",
            background: "var(--bg-elev)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: "1px solid var(--line)",
                background: "var(--panel)",
                display: "grid",
                placeItems: "center",
                color: "var(--green)",
              }}
            >
              <I.bot size={16} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="kicker">Agent builder</div>
              <h1 className="h1" style={{ fontSize: 24, marginTop: 3 }}>
                Describe the agent you want to build.
              </h1>
            </div>
            {savedAgent && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginLeft: "auto" }}
                onClick={() => navigate(agentEditorPath(savedAgent.id))}
              >
                <I.edit size={13} /> Open editor
              </button>
            )}
          </div>
        </div>
      )}

      <div
        style={{
          padding: embedded ? "14px 18px 16px" : "22px 28px",
          borderTop: embedded ? "1px solid var(--line)" : undefined,
          display: "grid",
          gridTemplateColumns: draft
            ? "repeat(auto-fit, minmax(min(100%, 340px), 1fr))"
            : "minmax(0, 760px)",
          gap: 18,
          alignItems: "start",
          justifyContent: draft ? "stretch" : "center",
        }}
      >
        <section className="card" style={{ padding: 14 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Prompt
          </div>
          <textarea
            className="field"
            style={{ minHeight: 118, background: "transparent", resize: "vertical" }}
            placeholder="e.g. Build an agent that reviews new support incidents, classifies severity, creates blockers for critical issues, and posts a concise handoff."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={working}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--line)",
            }}
          >
            <span className="mono muted" style={{ fontSize: 11 }}>
              {prompt.length} chars
            </span>
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginLeft: "auto" }}
              disabled={!prompt.trim() || working}
              onClick={() => {
                void generateDraft();
              }}
            >
              {mode === "drafting" ? (
                <span className="spin">
                  <I.refresh size={13} />
                </span>
              ) : (
                <I.sparkle size={13} />
              )}
              {draft ? " Regenerate draft" : " Generate draft"}
            </button>
          </div>
          {error && <ErrorNotice error={error} />}
        </section>

        {draft && (
          <section style={{ display: "grid", gap: 14 }}>
            <DraftSummary draft={draft} savedAgent={savedAgent} />
            <ReadinessGrid draft={draft} />
            <DraftPlan draft={draft} />
            <AgentConfiguration draft={draft} />
            <SampleInputs
              draft={draft}
              sampleInputs={sampleInputs}
              issues={sampleInputIssues}
              onUpdate={updateSample}
            />
            <ApproveCard
              draft={draft}
              working={working}
              savedAgent={savedAgent}
              runPreview={runPreview}
              sampleInputIssues={sampleInputIssues}
              onRunPreviewChange={setRunPreview}
              onApprove={() => {
                void approveDraft();
              }}
              onOpenAgent={() => savedAgent && navigate(agentEditorPath(savedAgent.id))}
            />
            {(firstRun || savedAgent) && <FirstRunPanel run={firstRun} agent={savedAgent} />}
          </section>
        )}
      </div>

      {working && (
        <div
          style={{
            position: "fixed",
            top: 60,
            right: 28,
            padding: "10px 14px",
            background: "var(--panel)",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--green)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            zIndex: 50,
          }}
        >
          <span className="spin">
            <I.refresh size={12} />
          </span>
          {mode === "drafting" ? "Generating agent draft..." : "Saving agent..."}
        </div>
      )}
    </div>
  );
}

function DraftSummary({
  draft,
  savedAgent,
}: {
  draft: AgentBuilderDraft;
  savedAgent: AgentRecord | null;
}) {
  return (
    <div
      className="card"
      style={{ padding: 16, borderColor: savedAgent ? "var(--green-deep)" : "var(--line)" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: "var(--bg-elev)",
            border: "1px solid var(--line)",
            display: "grid",
            placeItems: "center",
            color: "var(--green)",
            flexShrink: 0,
          }}
        >
          <I.bot size={16} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h2 className="h2" style={{ fontSize: 20, margin: 0 }}>
              {draft.agent.name}
            </h2>
            <span className={`pill ${savedAgent ? "good" : "warn"}`}>
              <span className="dot"></span>
              {savedAgent ? "saved" : "draft"}
            </span>
            <span
              className={`pill ${draft.authoring.source === "llm" ? "info" : "muted"}`}
              title={
                draft.authoring.source === "heuristic"
                  ? `LLM authoring fallback: ${draft.authoring.fallbackReason}`
                  : `Template category: ${draft.authoring.category}`
              }
            >
              <span className="dot"></span>
              {draft.authoring.source === "llm" ? "LLM-authored" : "deterministic"}
            </span>
          </div>
          <p className="muted" style={{ fontSize: 13, marginTop: 6, marginBottom: 10 }}>
            {draft.summary}
          </p>
          <div className="mono muted" style={{ fontSize: 11 }}>
            {draft.intent} - {draft.agent.triggerKind ?? "manual"} -{" "}
            {draft.agent.model ?? draft.readiness.provider.selectedModel ?? "model pending"}
          </div>
          <div className="mono muted" style={{ fontSize: 10.5, marginTop: 4 }}>
            {agentAuthoringLabel(draft)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReadinessGrid({ draft }: { draft: AgentBuilderDraft }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
        gap: 10,
      }}
    >
      <ReadinessCard
        icon={<I.key size={14} />}
        label="Provider"
        tone={providerReadinessTone(draft)}
        title={
          draft.readiness.provider.selectedProviderName ??
          draft.agent.providerId ??
          "Provider pending"
        }
        body={draft.readiness.provider.message}
        meta={draft.readiness.provider.selectedModel ?? draft.agent.model}
      />
      <ReadinessCard
        icon={<I.settings size={14} />}
        label="Tools"
        tone={toolReadinessTone(draft)}
        title={`${draftToolNames(draft).length} selected`}
        body={draft.readiness.tools.message}
        meta={
          draft.readiness.tools.missing.length
            ? `${draft.readiness.tools.missing.length} missing`
            : "ready"
        }
      />
      <ReadinessCard
        icon={<I.play size={14} />}
        label="First run"
        tone={firstRunReadinessTone(draft)}
        title={draft.readiness.firstRun.canRun ? "Runnable after save" : "Save only"}
        body={draft.readiness.firstRun.message}
        meta={draft.readiness.firstRun.blockers[0]}
      />
    </div>
  );
}

function ReadinessCard({
  icon,
  label,
  tone,
  title,
  body,
  meta,
}: {
  icon: React.ReactNode;
  label: string;
  tone: ReadinessTone;
  title: string;
  body: string;
  meta?: string;
}) {
  return (
    <div className="card" style={{ padding: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
        <span
          style={{
            color:
              tone === "good"
                ? "var(--green)"
                : tone === "danger"
                  ? "var(--danger)"
                  : tone === "warn"
                    ? "var(--warn)"
                    : "var(--silver-400)",
          }}
        >
          {icon}
        </span>
        <div className="kicker">{label}</div>
        <span className={`pill ${tone}`} style={{ marginLeft: "auto" }}>
          <span className="dot"></span>
          {tone === "good" ? "ready" : tone === "warn" ? "setup" : tone}
        </span>
      </div>
      <div style={{ color: "var(--silver-100)", fontSize: 13, fontWeight: 600 }}>{title}</div>
      <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.45, marginTop: 5 }}>
        {body}
      </p>
      {meta && (
        <div className="mono muted" style={{ fontSize: 10.5, marginTop: 8 }}>
          {meta}
        </div>
      )}
    </div>
  );
}

function DraftPlan({ draft }: { draft: AgentBuilderDraft }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <I.flow size={14} style={{ color: "var(--green)" }} />
        <div>
          <div className="kicker">
            Plan · {draft.plan.steps.length} step{draft.plan.steps.length === 1 ? "" : "s"}
          </div>
          <div style={{ fontSize: 13.5, color: "var(--silver-100)", marginTop: 2 }}>
            {draft.plan.title}
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        {draft.plan.steps.map((step, index) => (
          <div
            key={`${step.title}-${index}`}
            style={{
              display: "grid",
              gridTemplateColumns: "32px 1fr",
              gap: 10,
              paddingTop: index === 0 ? 0 : 7,
              borderTop: index === 0 ? "none" : "1px solid var(--line)",
            }}
          >
            <span className="mono muted" style={{ fontSize: 11 }}>
              {String(index + 1).padStart(2, "0")}
            </span>
            <div>
              <div style={{ fontSize: 12.5, color: "var(--silver-100)" }}>{step.title}</div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                {step.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
      {(draft.plan.acceptanceChecks.length > 0 || draft.plan.openQuestions.length > 0) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            gap: 12,
            marginTop: 14,
            paddingTop: 12,
            borderTop: "1px solid var(--line)",
          }}
        >
          <ListBlock label="Acceptance" items={draft.plan.acceptanceChecks} />
          <ListBlock label="Open questions" items={draft.plan.openQuestions} />
        </div>
      )}
    </div>
  );
}

function AgentConfiguration({ draft }: { draft: AgentBuilderDraft }) {
  const tools = draftToolNames(draft);
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="kicker" style={{ marginBottom: 10 }}>
        Agent configuration
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
          gap: 12,
        }}
      >
        <ConfigLine
          label="Description"
          value={draft.agent.description || "No description generated."}
        />
        <ConfigLine label="Trigger" value={draft.agent.triggerKind ?? "manual"} />
        <ConfigLine label="Schedule" value={draft.agent.schedule ?? "manual runs only"} />
        <ConfigLine label="Route key" value={draft.agent.routeKey ?? "generated on save"} />
      </div>
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
        <div className="kicker" style={{ marginBottom: 6 }}>
          Instructions
        </div>
        <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--silver-200)", margin: 0 }}>
          {draft.agent.instructions}
        </p>
      </div>
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
        <div className="kicker" style={{ marginBottom: 6 }}>
          Tools
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tools.map((tool) => (
            <span key={tool} className="pill info">
              {tool}
            </span>
          ))}
          {tools.length === 0 && (
            <span className="mono muted" style={{ fontSize: 11 }}>
              No tools selected.
            </span>
          )}
        </div>
        {draft.readiness.tools.missing.length > 0 && (
          <div className="mono" style={{ color: "var(--warn)", fontSize: 11, marginTop: 8 }}>
            Missing: {draft.readiness.tools.missing.join(", ")}
          </div>
        )}
      </div>
      {draft.readiness.webhook.recommended && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div className="kicker" style={{ marginBottom: 6 }}>
            Webhook
          </div>
          <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.45, margin: 0 }}>
            {draft.readiness.webhook.message}
          </p>
          {draft.readiness.webhook.publishSteps.length > 0 && (
            <div className="mono muted" style={{ fontSize: 10.5, marginTop: 6 }}>
              {draft.readiness.webhook.publishSteps.join(" -> ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SampleInputs({
  draft,
  sampleInputs,
  issues,
  onUpdate,
}: {
  draft: AgentBuilderDraft;
  sampleInputs: AgentBuilderSampleInputs;
  issues: AgentBuilderSampleInputIssue[];
  onUpdate: (key: string, value: string | boolean) => void;
}) {
  const schema = draft.agent.inputSchema ?? [];
  const looseKeys = Object.keys(sampleInputs).filter(
    (key) => !schema.some((field) => field.key === key),
  );
  const issuesByKey = new Map(issues.map((issue) => [issue.key, issue.message]));
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <div className="kicker">Sample inputs</div>
        <span className="mono muted" style={{ fontSize: 10.5 }}>
          {Object.keys(sampleInputs).length} field
          {Object.keys(sampleInputs).length === 1 ? "" : "s"}
        </span>
      </div>
      {schema.length === 0 && looseKeys.length === 0 ? (
        <div
          className="mono muted"
          style={{
            fontSize: 11,
            padding: "8px 10px",
            border: "1px dashed var(--line-2)",
            borderRadius: 6,
          }}
        >
          No run inputs needed for this draft.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
            gap: 10,
          }}
        >
          {schema.map((field) => (
            <SampleInputControl
              key={field.key}
              field={field}
              value={sampleInputs[field.key]}
              issue={issuesByKey.get(field.key)}
              onUpdate={onUpdate}
            />
          ))}
          {looseKeys.map((key) => (
            <label key={key} style={{ display: "block" }}>
              <span className="label">{key}</span>
              <input
                className="field"
                value={inputValueForField(sampleInputs[key])}
                onChange={(e) => onUpdate(key, e.target.value)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function SampleInputControl({
  field,
  value,
  issue,
  onUpdate,
}: {
  field: AgentInputField;
  value: string | number | boolean | undefined;
  issue?: string;
  onUpdate: (key: string, value: string | boolean) => void;
}) {
  if (field.type === "boolean") {
    return (
      <div style={{ paddingTop: 18 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onUpdate(field.key, e.target.checked)}
            style={{ accentColor: "var(--green)" }}
          />
          <span style={{ fontSize: 12.5, color: "var(--silver-200)" }}>
            {field.label}
            {field.required ? " *" : ""}
          </span>
        </label>
        {issue && (
          <div className="mono" style={{ color: "var(--danger)", fontSize: 10.5, marginTop: 5 }}>
            {issue}
          </div>
        )}
      </div>
    );
  }
  if (field.type === "enum") {
    return (
      <label style={{ display: "block" }}>
        <span className="label">
          {field.label}
          {field.required ? " *" : ""}
        </span>
        <select
          className="field"
          value={inputValueForField(value)}
          onChange={(e) => onUpdate(field.key, e.target.value)}
        >
          <option value="">- select -</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {issue && (
          <div className="mono" style={{ color: "var(--danger)", fontSize: 10.5, marginTop: 5 }}>
            {issue}
          </div>
        )}
      </label>
    );
  }
  return (
    <label style={{ display: "block" }}>
      <span className="label">
        {field.label}
        {field.required ? " *" : ""}
      </span>
      <input
        className="field"
        type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
        value={inputValueForField(value)}
        placeholder={field.description}
        onChange={(e) => onUpdate(field.key, e.target.value)}
      />
      {issue && (
        <div className="mono" style={{ color: "var(--danger)", fontSize: 10.5, marginTop: 5 }}>
          {issue}
        </div>
      )}
    </label>
  );
}

function ApproveCard({
  draft,
  working,
  savedAgent,
  runPreview,
  sampleInputIssues,
  onRunPreviewChange,
  onApprove,
  onOpenAgent,
}: {
  draft: AgentBuilderDraft;
  working: boolean;
  savedAgent: AgentRecord | null;
  runPreview: boolean;
  sampleInputIssues: AgentBuilderSampleInputIssue[];
  onRunPreviewChange: (next: boolean) => void;
  onApprove: () => void;
  onOpenAgent: () => void;
}) {
  const setupCanRun = draft.readiness.firstRun.canRun;
  const canRunPreview = setupCanRun && sampleInputIssues.length === 0;
  const runBlocker = setupCanRun
    ? sampleInputIssues[0]?.message
    : draft.readiness.firstRun.blockers.join(", ") || "not available";
  return (
    <div
      className="card"
      style={{ padding: 16, borderColor: savedAgent ? "var(--green-deep)" : "var(--line)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div>
          <div
            className="kicker"
            style={{ color: savedAgent ? "var(--green)" : "var(--silver-300)" }}
          >
            {savedAgent ? "Saved" : "Ready to approve"}
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            {savedAgent
              ? "The draft is now a saved agent. Open the editor to adjust tools, schedule, webhook, or playbook details."
              : "Approving saves the generated agent as active. The optional first run uses the generated sample inputs above."}
          </p>
        </div>
        {savedAgent ? (
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginLeft: "auto", flexShrink: 0 }}
            onClick={onOpenAgent}
          >
            <I.edit size={13} /> Open saved agent
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginLeft: "auto", flexShrink: 0 }}
            disabled={working}
            onClick={onApprove}
          >
            {working ? (
              <span className="spin">
                <I.refresh size={13} />
              </span>
            ) : (
              <I.check size={13} />
            )}
            {runPreview && canRunPreview ? " Approve, save & run" : " Approve & save"}
          </button>
        )}
      </div>
      {!savedAgent && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--line)",
            color: canRunPreview ? "var(--silver-200)" : "var(--silver-400)",
            fontSize: 12.5,
          }}
        >
          <input
            type="checkbox"
            checked={runPreview && canRunPreview}
            disabled={!canRunPreview || working}
            onChange={(e) => onRunPreviewChange(e.target.checked)}
            style={{ accentColor: "var(--green)" }}
          />
          Run once after save
          {!canRunPreview && (
            <span className="mono muted" style={{ fontSize: 10.5 }}>
              ({runBlocker})
            </span>
          )}
        </label>
      )}
    </div>
  );
}

function FirstRunPanel({ run, agent }: { run: AgentRunRecord | null; agent: AgentRecord | null }) {
  if (!run) {
    return (
      <div className="card" style={{ padding: 16 }}>
        <div className="kicker">First run</div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          {agent
            ? "No preview run was requested. The saved agent can be run from its editor."
            : "Save the draft to run a preview."}
        </p>
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <I.activity size={14} style={{ color: "var(--green)" }} />
        <div className="kicker">First run</div>
        <span className={`pill ${runStatusTone(run)}`} style={{ marginLeft: "auto" }}>
          <span className="dot"></span>
          {run.status}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
          gap: 12,
        }}
      >
        <div>
          <div className="label">Run</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--silver-200)" }}>
            {run.title || run.id}
          </div>
        </div>
        <div>
          <div className="label">Inputs</div>
          <div className="mono muted" style={{ fontSize: 11 }}>
            {Object.entries(run.inputs ?? {})
              .map(([key, value]) => `${key}: ${formatSampleValue(value)}`)
              .join(" - ") || "none"}
          </div>
        </div>
      </div>
      {run.output && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div className="kicker" style={{ marginBottom: 6 }}>
            Output
          </div>
          <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--silver-200)", margin: 0 }}>
            {run.output}
          </p>
        </div>
      )}
      {run.error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            border: "1px solid rgba(242,107,92,0.28)",
            borderRadius: 6,
            color: "var(--danger)",
            fontSize: 12,
          }}
        >
          {run.error}
        </div>
      )}
      {run.transcript && run.transcript.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div className="kicker" style={{ marginBottom: 6 }}>
            Transcript
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {run.transcript.map((step, index) => (
              <div
                key={step.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "32px 1fr auto",
                  gap: 8,
                  alignItems: "baseline",
                }}
              >
                <span className="mono muted" style={{ fontSize: 11 }}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span style={{ fontSize: 12, color: "var(--silver-200)" }}>{step.title}</span>
                <span
                  className={`pill ${step.status === "success" ? "good" : step.status === "failed" ? "danger" : "muted"}`}
                >
                  {step.status}
                </span>
                {step.output && (
                  <span className="muted" style={{ gridColumn: "2 / 4", fontSize: 11.5 }}>
                    {step.output}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {run.toolCalls && run.toolCalls.length > 0 && (
        <details style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <summary className="kicker" style={{ cursor: "pointer" }}>
            Actions taken - {run.toolCalls.length}
          </summary>
          <pre
            className="mono"
            style={{
              marginTop: 8,
              padding: 10,
              fontSize: 10.5,
              lineHeight: 1.5,
              background: "var(--ink)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              color: "var(--silver-200)",
              overflow: "auto",
            }}
          >
            {safeJson(run.toolCalls)}
          </pre>
        </details>
      )}
    </div>
  );
}

function ListBlock({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="kicker" style={{ marginBottom: 5 }}>
        {label}
      </div>
      {items.length === 0 ? (
        <div className="mono muted" style={{ fontSize: 11 }}>
          none
        </div>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {items.map((item, index) => (
            <div key={`${label}-${index}`} className="muted" style={{ fontSize: 11.5 }}>
              - {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div style={{ fontSize: 12.5, color: "var(--silver-200)" }}>{value}</div>
    </div>
  );
}

function ErrorNotice({ error }: { error: string }) {
  return (
    <div
      className="card"
      style={{
        padding: "10px 12px",
        marginTop: 12,
        borderColor: "rgba(242,107,92,0.3)",
        color: "var(--danger)",
      }}
    >
      <span className="mono" style={{ fontSize: 11.5 }}>
        ERR - {error}
      </span>
    </div>
  );
}
