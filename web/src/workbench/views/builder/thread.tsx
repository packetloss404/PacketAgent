import { I } from "../../icons";
import { translateError } from "@/lib/error-translator";
import type { AppBuilderDraft, AppBuilderIterationResult, BuilderModelPresetId } from "@/lib/types";
import { nextSmarterPreset } from "./helpers";
import type { ChatBody, ChatMessage } from "./types";

export function ThreadMessage({
  message,
  preset,
  onApplyIteration,
  onRevert,
  onFixErrors,
  onTrySmarter,
  onTellMeWhatToChange,
  working,
}: {
  message: ChatMessage;
  preset: BuilderModelPresetId;
  onApplyIteration: () => void;
  onRevert: (checkpointId: string) => void;
  onFixErrors: (errors: string[]) => void;
  onTrySmarter: (messageId: string) => void;
  onTellMeWhatToChange: (messageId: string) => void;
  working: boolean;
}) {
  const { role, body, streaming, checkpointId } = message;
  if (role === "system") {
    if (body.kind !== "status") return null;
    const tone = body.tone;
    const color =
      tone === "error"
        ? "var(--danger)"
        : tone === "warn"
          ? "var(--warn)"
          : tone === "ok"
            ? "var(--green)"
            : "var(--silver-400)";
    const Glyph =
      tone === "error" ? I.alert : tone === "warn" ? I.alert : tone === "ok" ? I.check : I.activity;
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 4px",
          color,
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
        }}
      >
        <Glyph size={12} />
        <span style={{ flex: 1 }}>{body.text}</span>
      </div>
    );
  }

  const isUser = role === "user";
  const isAssistant = role === "assistant";
  // Per-message revert is exposed only for assistant messages that produced a
  // checkpoint (plan or diff with a known checkpointId, never for streaming partials).
  const canRevert =
    !isUser && !streaming && !!checkpointId && (body.kind === "plan" || body.kind === "diff");
  // "Try again smarter" only makes sense on assistant plan/diff messages; we
  // disable while still streaming (no checkpointId yet means the turn is mid-flight).
  const canTrySmarter = isAssistant && (body.kind === "plan" || body.kind === "diff");
  const smarterTier = canTrySmarter ? nextSmarterPreset(preset) : null;
  const trySmarterDisabled = working || streaming || !checkpointId || !smarterTier;
  const trySmarterTitle = !smarterTier
    ? "Already at the highest preset."
    : streaming || !checkpointId
      ? "Wait for this response to finish before retrying."
      : `Re-run at the ${smarterTier} preset.`;
  // "Tell me what to change" renders on every assistant message so a confused
  // user always has a fast way to nudge the iteration composer with context.
  const canTellMe = isAssistant;
  const hoverBtnStyle = {
    padding: "2px 8px",
    fontSize: 10.5,
    background: "transparent",
    border: "1px solid var(--line-2)",
    borderRadius: 4,
    color: "var(--silver-300)",
    cursor: working ? "not-allowed" : "pointer",
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: 4,
    textTransform: "none" as const,
    letterSpacing: 0,
  };
  const hasAnyHoverAction = canRevert || canTrySmarter || canTellMe;
  return (
    <div className="group" style={{ display: "flex", gap: 8, position: "relative" }}>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          flexShrink: 0,
          background: isUser
            ? "linear-gradient(135deg, #3F4549, #1E2225)"
            : "linear-gradient(135deg, var(--green) 0%, var(--green-deep) 100%)",
          display: "grid",
          placeItems: "center",
          color: isUser ? "var(--silver-100)" : "#0E1A02",
          fontSize: 10,
          fontWeight: 700,
        }}
      >
        {isUser ? "U" : "TL"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="kicker"
          style={{ fontSize: 9.5, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}
        >
          <span>{isUser ? "You" : "PacketAgent"}</span>
          {streaming && (
            <span className="mono" style={{ color: "var(--green)" }}>
              · thinking
            </span>
          )}
          {hasAnyHoverAction && (
            <div
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition"
              style={{ marginLeft: "auto", display: "inline-flex", gap: 4, alignItems: "center" }}
            >
              {canTrySmarter && (
                <button
                  type="button"
                  className="mono"
                  onClick={() => onTrySmarter(message.id)}
                  disabled={trySmarterDisabled}
                  title={trySmarterTitle}
                  style={{
                    ...hoverBtnStyle,
                    cursor: trySmarterDisabled ? "not-allowed" : "pointer",
                    opacity: trySmarterDisabled ? 0.55 : 1,
                  }}
                >
                  <I.zap size={11} /> Try again smarter
                </button>
              )}
              {canTellMe && (
                <button
                  type="button"
                  className="mono"
                  onClick={() => onTellMeWhatToChange(message.id)}
                  disabled={working}
                  title="Focus the iteration composer with this message as context."
                  style={hoverBtnStyle}
                >
                  <I.edit size={11} /> Tell me what to change
                </button>
              )}
              {canRevert && (
                <button
                  type="button"
                  className="mono"
                  onClick={() => onRevert(checkpointId!)}
                  disabled={working}
                  title={`Revert app to the checkpoint produced by this message (${checkpointId!.slice(0, 8)})`}
                  style={hoverBtnStyle}
                >
                  <span aria-hidden>↶</span> Revert to here
                </button>
              )}
            </div>
          )}
        </div>
        <ThreadMessageBody
          body={body}
          onApplyIteration={onApplyIteration}
          onFixErrors={onFixErrors}
          working={working}
        />
      </div>
    </div>
  );
}

function ThreadMessageBody({
  body,
  onApplyIteration,
  onFixErrors,
  working,
}: {
  body: ChatBody;
  onApplyIteration: () => void;
  onFixErrors: (errors: string[]) => void;
  working: boolean;
}) {
  if (body.kind === "text") {
    return (
      <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--silver-100)" }}>{body.text}</div>
    );
  }
  if (body.kind === "steps") {
    if (body.steps.length === 0) {
      return (
        <div className="mono muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>
          working…
        </div>
      );
    }
    return (
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: "none",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {body.steps.map((step, i) => (
          <li
            key={i}
            className="mono"
            style={{
              fontSize: 12,
              color: "var(--silver-300)",
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <span style={{ color: "var(--green)" }}>›</span>
            <span>{step}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (body.kind === "prose") {
    return (
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--silver-100)",
          whiteSpace: "pre-wrap",
        }}
      >
        {body.text || (
          <span className="muted" style={{ fontStyle: "italic" }}>
            working…
          </span>
        )}
      </div>
    );
  }
  if (body.kind === "plan") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--silver-100)" }}>
          {body.draft.summary}
        </div>
        <PlanCard draft={body.draft} />
      </div>
    );
  }
  if (body.kind === "diff") {
    return (
      <IterationCard iteration={body.iteration} onApply={onApplyIteration} working={working} />
    );
  }
  if (body.kind === "validation-errors") {
    const errors = body.errors;
    return (
      <div
        className="card"
        style={{
          marginLeft: 30,
          padding: 12,
          background: "rgba(244,180,69,0.08)",
          borderColor: "rgba(244,180,69,0.35)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <I.alert size={13} style={{ color: "var(--warn)" }} />
          <div className="kicker" style={{ color: "var(--warn)" }}>
            Build errors · {errors.length} issue{errors.length === 1 ? "" : "s"}
          </div>
        </div>
        <ul
          className="mono"
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11.5,
            color: "var(--silver-200)",
            maxHeight: 220,
            overflow: "auto",
          }}
        >
          {errors.map((err, i) => (
            <li key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {err}
            </li>
          ))}
        </ul>
        {body.canFix && (
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={working}
              onClick={() => onFixErrors(errors)}
              style={{
                background: "rgba(244,180,69,0.12)",
                borderColor: "rgba(244,180,69,0.4)",
                color: "var(--warn)",
                fontSize: 11.5,
              }}
            >
              {working ? (
                <span className="spin">
                  <I.refresh size={11} />
                </span>
              ) : (
                <I.zap size={11} />
              )}
              {working ? " Fixing…" : " Fix these errors"}
            </button>
          </div>
        )}
      </div>
    );
  }
  if (body.kind === "status") {
    if (body.tone === "error") {
      return <FriendlyErrorCard raw={body.text} />;
    }
    const color =
      body.tone === "warn"
        ? "var(--warn)"
        : body.tone === "ok"
          ? "var(--green)"
          : "var(--silver-300)";
    return (
      <div className="mono" style={{ fontSize: 12, color }}>
        {body.text}
      </div>
    );
  }
  return null;
}

/**
 * Renders a chat-thread error tone with non-technical copy and an optional
 * "Try again" button. Retry dispatches a window-level `packetagent:retry-last-action`
 * event so BuilderView can re-seed the composer with the last prompt — keeping
 * this component decoupled from the action plumbing.
 */
function FriendlyErrorCard({ raw }: { raw: string }) {
  const friendly = translateError(raw);
  const handleRetry = () => {
    window.dispatchEvent(new CustomEvent("packetagent:retry-last-action"));
  };
  return (
    <div
      className="card"
      role="alert"
      aria-live="polite"
      style={{
        marginLeft: 30,
        padding: 12,
        background: "rgba(232,90,90,0.06)",
        borderColor: "rgba(232,90,90,0.35)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <I.alert size={14} style={{ color: "var(--danger)", marginTop: 2, flexShrink: 0 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--silver-100)" }}>
            {friendly.title}
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--silver-200)" }}>
            {friendly.body}
          </div>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
            {friendly.suggestion}
          </div>
        </div>
      </div>
      {friendly.retryable && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleRetry}
            style={{
              background: "rgba(232,90,90,0.1)",
              borderColor: "rgba(232,90,90,0.35)",
              color: "var(--silver-100)",
              fontSize: 11.5,
            }}
          >
            <I.refresh size={11} />
            {" Try again"}
          </button>
        </div>
      )}
      {friendly.technical && (
        <details style={{ marginTop: 2 }}>
          <summary
            className="muted"
            style={{ fontSize: 11, cursor: "pointer", userSelect: "none" }}
          >
            Show technical details
          </summary>
          <pre
            className="mono"
            style={{
              margin: "6px 0 0",
              padding: 8,
              background: "var(--bg)",
              border: "1px solid var(--line-2)",
              borderRadius: 6,
              fontSize: 11,
              color: "var(--silver-300)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {friendly.technical}
          </pre>
        </details>
      )}
    </div>
  );
}

function PlanCard({ draft }: { draft: AppBuilderDraft }) {
  return (
    <div className="card" style={{ padding: 14, marginLeft: 30 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <I.flow size={14} style={{ color: "var(--green)" }} />
        <div className="kicker">
          Plan · {draft.plan.steps.length} step{draft.plan.steps.length === 1 ? "" : "s"}
        </div>
      </div>
      <div style={{ fontSize: 13.5, color: "var(--silver-100)", marginBottom: 8 }}>
        {draft.plan.title}
      </div>
      {draft.plan.steps.map((step, i) => (
        <div key={i} style={{ display: "flex", gap: 8, padding: "5px 0", fontSize: 12.5 }}>
          <span className="mono muted" style={{ fontSize: 11, paddingTop: 1, width: 24 }}>
            {String(i + 1).padStart(2, "0")}
          </span>
          <div>
            <div style={{ color: "var(--silver-100)" }}>{step.title}</div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
              {step.detail}
            </div>
          </div>
        </div>
      ))}
      {draft.plan.acceptanceChecks.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
          <div className="kicker" style={{ marginBottom: 4 }}>
            Acceptance
          </div>
          {draft.plan.acceptanceChecks.map((c, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--silver-300)", padding: "2px 0" }}>
              · {c}
            </div>
          ))}
        </div>
      )}
      {draft.plan.openQuestions.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
          <div className="kicker" style={{ marginBottom: 4 }}>
            Open questions
          </div>
          {draft.plan.openQuestions.map((q, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--warn)", padding: "2px 0" }}>
              ? {q}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IterationCard({
  iteration,
  onApply,
  working,
}: {
  iteration: AppBuilderIterationResult;
  onApply: () => void;
  working: boolean;
}) {
  return (
    <div className="card" style={{ marginLeft: 30, overflow: "hidden" }}>
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <I.branch size={13} style={{ color: "var(--green)" }} />
        <div style={{ fontSize: 11.5, color: "var(--silver-200)" }}>
          Latest change · {iteration.files.length} file{iteration.files.length === 1 ? "" : "s"}
        </div>
        <span
          className={`pill ${iteration.status === "applied" ? "good" : iteration.status === "blocked" ? "danger" : "warn"}`}
          style={{ marginLeft: "auto" }}
        >
          <span className="dot"></span>
          {iteration.status}
        </span>
      </div>
      <div style={{ padding: "8px 14px", fontSize: 12.5, color: "var(--silver-200)" }}>
        {iteration.summary}
      </div>
      <div className="mono" style={{ fontSize: 11.5, padding: "6px 14px" }}>
        {iteration.files.map((f, i) => (
          <div
            key={i}
            style={{ display: "flex", gap: 8, padding: "3px 0", color: "var(--silver-300)" }}
          >
            <span
              style={{
                color:
                  f.changeType === "added"
                    ? "var(--green)"
                    : f.changeType === "modified"
                      ? "var(--warn)"
                      : "var(--danger)",
                width: 12,
              }}
            >
              {f.changeType === "added"
                ? "A"
                : f.changeType === "modified"
                  ? "M"
                  : f.changeType === "deleted"
                    ? "D"
                    : "R"}
            </span>
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {f.path}
            </span>
          </div>
        ))}
      </div>
      {iteration.status !== "applied" && (
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line)" }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={working}
            onClick={onApply}
          >
            {working ? (
              <span className="spin">
                <I.refresh size={11} />
              </span>
            ) : (
              <I.check size={11} />
            )}
            {working ? " Applying…" : " Apply changes"}
          </button>
        </div>
      )}
    </div>
  );
}
