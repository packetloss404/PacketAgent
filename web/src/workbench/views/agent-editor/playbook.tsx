import { useState } from "react";
import type { AgentPlaybookStep, AgentRunRecord, AgentRunToolCall } from "@/lib/types";
import { I } from "../../icons";
import { formatStepList, formatStepNumber, missingPlaybookTitleIndexes } from "./helpers";

export function PlaybookReplacementReview({
  run,
  currentStepCount,
  recording,
  canRunAgent,
  onConfirm,
  onCancel,
}: {
  run: AgentRunRecord;
  currentStepCount: number;
  recording: boolean;
  canRunAgent: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const preview = playbookPreviewFromToolCalls(run.toolCalls ?? []);
  if (preview.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Review playbook replacement"
      style={{
        border: "1px solid rgba(242,196,92,0.32)",
        background: "rgba(242,196,92,0.045)",
        borderRadius: 6,
        padding: 10,
        display: "grid",
        gap: 9,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <I.alert size={13} style={{ color: "var(--warn)", marginTop: 1, flexShrink: 0 }} />
        <div>
          <div className="kicker" style={{ color: "var(--warn)", marginBottom: 4 }}>
            REVIEW REPLACEMENT
          </div>
          <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: "var(--silver-300)" }}>
            This will replace the current {formatStepCount(currentStepCount)} with{" "}
            {formatStepCount(preview.length)} captured from this run.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        {preview.slice(0, 5).map((step, index) => (
          <div
            key={`${step.title}-${index}`}
            style={{
              display: "grid",
              gridTemplateColumns: "26px 1fr",
              gap: 8,
              alignItems: "start",
            }}
          >
            <span className="mono muted" style={{ fontSize: 10.5 }}>
              {formatStepNumber(index)}
            </span>
            <span style={{ minWidth: 0 }}>
              <span
                className="mono"
                style={{
                  display: "block",
                  fontSize: 11.5,
                  color: "var(--silver-100)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {step.title}
              </span>
              <span
                className="muted"
                style={{
                  display: "block",
                  fontSize: 10.5,
                  lineHeight: 1.35,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {step.instruction}
              </span>
            </span>
          </div>
        ))}
        {preview.length > 5 && (
          <div className="mono muted" style={{ fontSize: 10.5 }}>
            +{preview.length - 5} more steps
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onConfirm}
          disabled={!canRunAgent || recording}
        >
          {recording ? (
            <span className="spin">
              <I.refresh size={11} />
            </span>
          ) : (
            <I.check size={11} />
          )}
          {recording ? " Replacing..." : " Confirm replace"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={recording}>
          <I.close size={11} /> Cancel
        </button>
      </div>
    </div>
  );
}

function playbookPreviewFromToolCalls(calls: AgentRunToolCall[]) {
  return calls.slice(0, 20).map((call, index) => ({
    title: `${index + 1}. ${call.toolName}`,
    instruction: `Call ${call.toolName} with: ${stringifyToolCallInput(call.input).slice(0, 380)}`,
  }));
}

function stringifyToolCallInput(input: unknown) {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function formatStepCount(count: number) {
  return `${count} step${count === 1 ? "" : "s"}`;
}

// ─── PlaybookEditor ─────────────────────────────────────────────────────────
export function PlaybookEditor({
  steps,
  showValidation,
  onChange,
}: {
  steps: AgentPlaybookStep[];
  showValidation: boolean;
  onChange: (next: AgentPlaybookStep[]) => void;
}) {
  const [touchedTitleIds, setTouchedTitleIds] = useState<Set<string>>(() => new Set());
  const update = (index: number, patch: Partial<AgentPlaybookStep>) => {
    const next = steps.slice();
    next[index] = { ...next[index]!, ...patch };
    onChange(next);
  };
  const addStep = () =>
    onChange([
      ...steps,
      {
        id: `step_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        title: "",
        instruction: "",
      },
    ]);
  const removeStep = (index: number) => {
    const next = steps.slice();
    next.splice(index, 1);
    onChange(next);
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = steps.slice();
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const missingTitles = missingPlaybookTitleIndexes(steps);
  const touchTitle = (stepId: string) => {
    setTouchedTitleIds((previous) => {
      const next = new Set(previous);
      next.add(stepId);
      return next;
    });
  };
  return (
    <div>
      {showValidation && missingTitles.length > 0 && (
        <div
          role="alert"
          style={{
            border: "1px solid rgba(242,107,92,0.34)",
            background: "rgba(242,107,92,0.06)",
            borderRadius: 6,
            padding: "9px 10px",
            marginBottom: 10,
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            color: "var(--danger)",
          }}
        >
          <I.alert size={13} style={{ marginTop: 1, flexShrink: 0 }} />
          <span className="mono" style={{ fontSize: 11, lineHeight: 1.4 }}>
            {missingTitles.length === 1
              ? `Step ${formatStepList(missingTitles)} needs a title before this playbook can be saved.`
              : `Steps ${formatStepList(missingTitles)} need titles before this playbook can be saved.`}
          </span>
        </div>
      )}
      {steps.length === 0 ? (
        <div
          className="card muted"
          style={{ padding: "12px 14px", textAlign: "center", fontSize: 12 }}
        >
          — empty playbook · add a step so each run produces a transcript —
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {steps.map((step, index) => {
            const stepNumber = formatStepNumber(index);
            const missingTitle = step.title.trim().length === 0;
            const showTitleError =
              missingTitle &&
              (showValidation ||
                touchedTitleIds.has(step.id) ||
                step.instruction.trim().length > 0);
            const titleErrorId = `playbook_${step.id}_title_error`;
            return (
              <div
                key={step.id}
                className="card"
                style={{
                  padding: 12,
                  display: "grid",
                  gridTemplateColumns: "32px 1fr 36px",
                  gap: 10,
                  borderColor: showTitleError ? "rgba(242,107,92,0.38)" : undefined,
                }}
              >
                <div className="mono muted" style={{ fontSize: 11, paddingTop: 21 }}>
                  {stepNumber}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span className="label">Title</span>
                    <input
                      className="field"
                      placeholder="Step title"
                      value={step.title}
                      aria-invalid={showTitleError}
                      aria-describedby={showTitleError ? titleErrorId : undefined}
                      onBlur={() => touchTitle(step.id)}
                      onChange={(e) => update(index, { title: e.target.value })}
                    />
                    {showTitleError && (
                      <span
                        id={titleErrorId}
                        role="alert"
                        className="mono"
                        style={{ fontSize: 10.5, color: "var(--danger)" }}
                      >
                        ERR · Step {stepNumber} needs a title or should be removed.
                      </span>
                    )}
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span className="label">Instruction</span>
                    <textarea
                      className="field"
                      rows={2}
                      placeholder="What the agent should do"
                      value={step.instruction}
                      onChange={(e) => update(index, { instruction: e.target.value })}
                    />
                  </label>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 4,
                    fontSize: 11,
                    paddingTop: 18,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move step ${stepNumber} up`}
                    title={`Move step ${stepNumber} up`}
                    className="btn btn-sm"
                    style={{
                      width: 30,
                      height: 26,
                      padding: 0,
                      justifyContent: "center",
                      opacity: index === 0 ? 0.3 : 1,
                    }}
                  >
                    <I.arrowUp size={11} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === steps.length - 1}
                    aria-label={`Move step ${stepNumber} down`}
                    title={`Move step ${stepNumber} down`}
                    className="btn btn-sm"
                    style={{
                      width: 30,
                      height: 26,
                      padding: 0,
                      justifyContent: "center",
                      opacity: index === steps.length - 1 ? 0.3 : 1,
                    }}
                  >
                    <I.chevDown size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeStep(index)}
                    aria-label={`Remove step ${stepNumber}`}
                    title={`Remove step ${stepNumber}`}
                    className="btn btn-sm"
                    style={{
                      width: 30,
                      height: 26,
                      padding: 0,
                      justifyContent: "center",
                      color: "var(--danger)",
                    }}
                  >
                    <I.trash size={11} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button type="button" onClick={addStep} className="btn btn-sm">
          <I.plus size={11} /> Add step
        </button>
      </div>
    </div>
  );
}
