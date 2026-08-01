import {
  agentAuthoringLabel,
  draftToolNames,
  firstRunReadinessTone,
  providerCapabilityReadinessTone,
  providerCapabilitySummary,
  providerCredentialLabel,
  providerReadinessTone,
  type ReadinessTone,
  toolReadinessTone,
} from "../builder-agent-utils";
import { I } from "../../icons";
import { type AgentBuilderDraft, type AgentRecord } from "@/lib/types";

export function DraftSummary({
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

export function ReadinessGrid({ draft }: { draft: AgentBuilderDraft }) {
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
        meta={providerCredentialLabel(draft)}
      />
      <ReadinessCard
        icon={<I.cpu size={14} />}
        label="Model"
        tone={draft.readiness.provider.selectedModel ? "warn" : "danger"}
        statusLabel={
          draft.readiness.provider.modelAvailability === "configured_unverified"
            ? "unverified"
            : "missing"
        }
        title={draft.readiness.provider.selectedModel ?? "Model pending"}
        body={
          draft.readiness.provider.warnings[0] ??
          "Choose a provider and model before the first run."
        }
        meta={`preset: ${draft.readiness.provider.preset}`}
      />
      <ReadinessCard
        icon={<I.shield size={14} />}
        label="Capabilities"
        tone={providerCapabilityReadinessTone(draft)}
        statusLabel={draft.readiness.provider.capabilities.toolUse.status}
        title={
          draft.readiness.provider.capabilities.toolUse.required
            ? `Tool use: ${draft.readiness.provider.capabilities.toolUse.support}`
            : "No runtime tool use required"
        }
        body={providerCapabilitySummary(draft)}
        meta={
          draft.readiness.provider.warnings.find((warning) =>
            /tool use|structured output/i.test(warning),
          ) ?? "Catalog capability policy"
        }
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
  statusLabel,
}: {
  icon: React.ReactNode;
  label: string;
  tone: ReadinessTone;
  title: string;
  body: string;
  meta?: string;
  statusLabel?: string;
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
          {statusLabel ?? (tone === "good" ? "ready" : tone === "warn" ? "setup" : tone)}
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

export function DraftPlan({ draft }: { draft: AgentBuilderDraft }) {
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
