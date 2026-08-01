import { I } from "../../icons";
import { type AgentBuilderDraft, type AgentInputField, type AgentMemoryEntry } from "@/lib/types";
import {
  type AgentBuilderSampleInputIssue,
  type AgentBuilderSampleInputs,
  draftToolNames,
  inputValueForField,
} from "../builder-agent-utils";

export function AgentConfiguration({
  draft,
  editable,
  onMemoryChange,
  onExpectedOutputChange,
}: {
  draft: AgentBuilderDraft;
  editable: boolean;
  onMemoryChange: (memory: AgentMemoryEntry[]) => void;
  onExpectedOutputChange: (value: string) => void;
}) {
  const tools = draftToolNames(draft);
  const memory = draft.agent.memory ?? [];
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div className="kicker">Memory</div>
          <span className="mono muted" style={{ fontSize: 10.5 }}>
            non-secret context · {memory.length}/12
          </span>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: "auto" }}
            disabled={!editable || memory.length >= 12}
            onClick={() =>
              onMemoryChange([
                ...memory,
                {
                  id: `memory_${Date.now()}`,
                  label: "Context",
                  content: "",
                },
              ])
            }
          >
            <I.plus size={11} /> Add
          </button>
        </div>
        {memory.length === 0 ? (
          <div className="mono muted" style={{ fontSize: 11 }}>
            No saved context. Add bounded, non-secret facts for real model-backed Agent runs.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {memory.map((entry, index) => (
              <div
                key={entry.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(120px, 0.35fr) minmax(0, 1fr) auto",
                  gap: 8,
                  alignItems: "start",
                }}
              >
                <input
                  className="field"
                  aria-label={`Memory ${index + 1} label`}
                  value={entry.label}
                  maxLength={80}
                  disabled={!editable}
                  onChange={(event) =>
                    onMemoryChange(
                      memory.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, label: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
                <textarea
                  className="field"
                  aria-label={`Memory ${index + 1} content`}
                  value={entry.content}
                  maxLength={1_000}
                  rows={2}
                  disabled={!editable}
                  style={{ resize: "vertical" }}
                  onChange={(event) =>
                    onMemoryChange(
                      memory.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, content: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={`Remove memory ${index + 1}`}
                  disabled={!editable}
                  style={{ color: "var(--danger)" }}
                  onClick={() =>
                    onMemoryChange(memory.filter((_, candidateIndex) => candidateIndex !== index))
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
        <div className="kicker" style={{ marginBottom: 6 }}>
          First-run expected output
        </div>
        <textarea
          className="field"
          value={draft.agent.evaluationSpec?.expectedOutput ?? ""}
          maxLength={1_200}
          rows={3}
          disabled={!editable}
          style={{ resize: "vertical" }}
          onChange={(event) => onExpectedOutputChange(event.target.value)}
        />
        {!editable && (
          <div className="mono muted" style={{ fontSize: 10.5, marginTop: 6 }}>
            Saved configuration is frozen here. Open the Agent editor to make another revision.
          </div>
        )}
        <div className="mono muted" style={{ fontSize: 10.5, marginTop: 6 }}>
          Structural pass/fail checks use run status, saved example inputs, non-empty output, and
          required tools. This description stays visible for operator review and is not scored by a
          second model.
        </div>
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

export function SampleInputs({
  draft,
  editable,
  sampleInputs,
  issues,
  onUpdate,
}: {
  draft: AgentBuilderDraft;
  editable: boolean;
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
        <div className="kicker">First-run input example</div>
        <span className="mono muted" style={{ fontSize: 10.5 }}>
          {Object.keys(sampleInputs).length} field
          {Object.keys(sampleInputs).length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: -2, marginBottom: 10 }}>
        These values are saved on the input schema and become the expected inputs for the first-run
        evaluation.
      </p>
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
              editable={editable}
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
                disabled={!editable}
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
  editable,
  value,
  issue,
  onUpdate,
}: {
  field: AgentInputField;
  editable: boolean;
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
            disabled={!editable}
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
          disabled={!editable}
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
        disabled={!editable}
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

function ConfigLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div style={{ fontSize: 12.5, color: "var(--silver-200)" }}>{value}</div>
    </div>
  );
}
