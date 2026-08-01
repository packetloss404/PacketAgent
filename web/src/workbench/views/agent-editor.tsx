import { I } from "../icons";
import { Topbar } from "../Shell";
import { triggerLabel, TRIGGER_KINDS } from "@/lib/agent-runtime";
import { InputSchemaEditor, MemoryEditor, ToolPicker } from "./agent-editor/contract-editors";
import { Field, Row, Section } from "./agent-editor/layout";
import { PlaybookEditor } from "./agent-editor/playbook";
import { AgentRunSidebar } from "./agent-editor/run-sidebar";
import { useAgentEditorController } from "./agent-editor/use-agent-editor-controller";
export { RunTranscript, ToolCallTimeline } from "./agent-editor/run-presenters";

function webhookOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

export function AgentEditorView() {
  const {
    isNew,
    canManageAgent,
    canRunAgent,
    agent,
    runs,
    providers,
    playbook,
    triggerKind,
    schedule,
    inputSchema,
    memory,
    evaluationExpectedOutput,
    evaluationTools,
    enabledTools,
    availableTools,
    runInputs,
    webhookBusy,
    recordingRunId,
    loading,
    saving,
    exporting,
    running,
    error,
    message,
    expandedRun,
    pendingApproval,
    playbookValidationVisible,
    playbookReviewRunId,
    toolSectionRef,
    defaults,
    nextRunLabel,
    firstRunEvaluationPending,
    scheduleValidation,
    showScheduleValidation,
    saveAgent,
    archive,
    exportBundle,
    rotateWebhook,
    removeWebhook,
    recordAsPlaybook,
    updateEnabledTools,
    updateRunInputValue,
    updateInputSchema,
    updateTriggerKind,
    runNow,
    launchPendingApproval,
    editPendingTools,
    cancelPendingApproval,
    updatePlaybook,
    webhookPathToken,
    hasWebhook,
    setSchedule,
    setScheduleTouched,
    setMemory,
    setEvaluationExpectedOutput,
    setEvaluationTools,
    setExpandedRun,
    setPlaybookReviewRunId,
  } = useAgentEditorController();
  return (
    <>
      <Topbar
        crumbs={["__WS__", "Agents", isNew ? "New" : (agent?.name ?? "Edit")]}
        actions={
          !isNew && agent ? (
            <>
              <button
                type="button"
                className="top-btn"
                onClick={() => {
                  void runNow();
                }}
                disabled={!canRunAgent || running || saving}
              >
                {running ? (
                  <span className="spin">
                    <I.refresh size={13} />
                  </span>
                ) : (
                  <I.play size={13} />
                )}{" "}
                {firstRunEvaluationPending ? "Evaluate first run" : "Run now"}
              </button>
              {canManageAgent && (
                <button
                  type="button"
                  className="top-btn"
                  onClick={() => {
                    void exportBundle();
                  }}
                  disabled={saving || exporting}
                >
                  <I.download size={13} /> {exporting ? "Exporting…" : "Export"}
                </button>
              )}
              {canManageAgent && (
                <button
                  type="button"
                  className="top-btn"
                  onClick={() => {
                    void archive();
                  }}
                  disabled={saving}
                >
                  <I.trash size={13} /> Archive
                </button>
              )}
            </>
          ) : null
        }
      />

      <div style={{ padding: "26px 28px 60px", maxWidth: 1280 }}>
        {loading && (
          <div className="muted" style={{ padding: 16 }}>
            Loading agent…
          </div>
        )}

        {!loading && !canManageAgent && (
          <div
            className="card"
            style={{ padding: "10px 14px", marginBottom: 14, borderColor: "var(--line-2)" }}
          >
            <span className="mono muted" style={{ fontSize: 11 }}>
              Admin role required to create, edit, archive, or manage webhooks for agents.
            </span>
          </div>
        )}

        {error && (
          <div
            className="card"
            style={{
              padding: "10px 14px",
              marginBottom: 14,
              borderColor: "rgba(242,107,92,0.3)",
              background: "rgba(242,107,92,0.06)",
              color: "var(--danger)",
            }}
          >
            <span className="mono" style={{ fontSize: 11.5 }}>
              ERR · {error}
            </span>
          </div>
        )}
        {message && !error && (
          <div
            className="card"
            style={{
              padding: "10px 14px",
              marginBottom: 14,
              borderColor: "rgba(184,242,92,0.3)",
              background: "rgba(184,242,92,0.06)",
              color: "var(--green)",
            }}
          >
            <span className="mono" style={{ fontSize: 11.5 }}>
              OK · {message}
            </span>
          </div>
        )}

        {!loading && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
              gap: 24,
              alignItems: "start",
            }}
          >
            <form onSubmit={saveAgent}>
              <fieldset disabled={!canManageAgent} style={{ border: 0, padding: 0, margin: 0 }}>
                <Section number="01 / 05" kicker="CONFIGURATION" title="Identity & instructions">
                  <Row>
                    <Field label="Name">
                      <input name="name" defaultValue={defaults.name} className="field" required />
                    </Field>
                    <Field label="Status">
                      <select name="status" defaultValue={defaults.status} className="field">
                        <option value="active">active</option>
                        <option value="paused">paused</option>
                      </select>
                    </Field>
                  </Row>
                  <Field label="Description">
                    <input
                      name="description"
                      defaultValue={defaults.description}
                      className="field"
                      placeholder="What this agent does"
                    />
                  </Field>
                  <Field label="Instructions · system prompt">
                    <textarea
                      name="instructions"
                      defaultValue={defaults.instructions}
                      rows={6}
                      className="field"
                      required
                    />
                  </Field>
                  <Row>
                    <Field label="Provider">
                      <select
                        name="providerId"
                        defaultValue={defaults.providerId}
                        className="field"
                      >
                        <option value="">— no provider yet —</option>
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Model">
                      <input
                        name="model"
                        defaultValue={defaults.model}
                        className="field"
                        placeholder="gpt-4.1-mini"
                      />
                    </Field>
                  </Row>
                  <Field label="Tools / integrations · comma-separated tags">
                    <input
                      name="tools"
                      defaultValue={defaults.tools?.join(", ")}
                      className="field"
                      placeholder="gmail, slack, github"
                    />
                  </Field>
                </Section>

                <Section
                  number="02 / 05"
                  kicker="TRIGGER"
                  title="Invocation rules"
                  sub="How this agent gets invoked. Manual always works; schedules drive the next-run estimate."
                >
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                    {TRIGGER_KINDS.map((kind) => {
                      const active = triggerKind === kind;
                      return (
                        <button
                          type="button"
                          key={kind}
                          onClick={() => updateTriggerKind(kind)}
                          className={active ? "btn-primary btn btn-sm" : "btn btn-sm"}
                        >
                          {triggerLabel(kind)}
                        </button>
                      );
                    })}
                  </div>
                  <Row>
                    <Field
                      label={
                        triggerKind === "schedule" ? "Cron schedule *" : "Cron schedule · optional"
                      }
                    >
                      <input
                        name="schedule"
                        className="field mono"
                        value={schedule}
                        onBlur={() => setScheduleTouched(true)}
                        onChange={(e) => {
                          setSchedule(e.target.value);
                          setScheduleTouched(true);
                        }}
                        placeholder="0 8 * * 1-5"
                        required={triggerKind === "schedule"}
                      />
                      <p className="mono muted" style={{ fontSize: 10, marginTop: 6 }}>
                        Five-field cron in workspace time. Examples:{" "}
                        <span style={{ color: "var(--silver-200)" }}>0 8 * * 1-5</span> weekdays at
                        08:00, <span style={{ color: "var(--silver-200)" }}>*/30 * * * *</span>{" "}
                        every 30m.
                      </p>
                      {showScheduleValidation && (
                        <p
                          className="mono"
                          style={{ fontSize: 10.5, marginTop: 4, color: "var(--danger)" }}
                        >
                          ERR · {scheduleValidation}
                        </p>
                      )}
                    </Field>
                    <Field label={triggerKind === "schedule" ? "Next run" : "Trigger mode"}>
                      <div className="field mono" style={{ background: "var(--bg-elev)" }}>
                        {nextRunLabel}
                      </div>
                    </Field>
                  </Row>
                  {!isNew && agent && (
                    <div
                      style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}
                    >
                      <div className="kicker" style={{ marginBottom: 6 }}>
                        WEBHOOK TRIGGER
                      </div>
                      {hasWebhook ? (
                        <div style={{ display: "grid", gap: 8 }}>
                          <div
                            className="mono"
                            style={{
                              fontSize: 11,
                              padding: "8px 10px",
                              background: "var(--ink)",
                              border: "1px solid var(--line)",
                              borderRadius: 6,
                              color: "var(--silver-200)",
                              wordBreak: "break-all",
                            }}
                          >
                            POST {webhookOrigin()}/api/public/webhooks/agents/
                            {webhookPathToken ?? "[redacted]"}
                          </div>
                          <p className="mono muted" style={{ fontSize: 10 }}>
                            Body is forwarded as the run's `inputs`. Trigger kind = webhook. Full
                            token is only shown immediately after rotation.
                          </p>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                void rotateWebhook();
                              }}
                              disabled={webhookBusy}
                            >
                              <I.refresh size={11} /> Rotate token
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                void removeWebhook();
                              }}
                              disabled={webhookBusy}
                              style={{ color: "var(--danger)" }}
                            >
                              <I.trash size={11} /> Remove
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            void rotateWebhook();
                          }}
                          disabled={webhookBusy}
                        >
                          <I.plus size={11} /> Generate webhook URL
                        </button>
                      )}
                    </div>
                  )}
                </Section>

                <Section
                  number="03 / 05"
                  kicker={`PLAYBOOK · ${playbook.length} STEP${playbook.length === 1 ? "" : "S"}`}
                  title="Ordered steps"
                >
                  <PlaybookEditor
                    steps={playbook}
                    showValidation={playbookValidationVisible}
                    onChange={updatePlaybook}
                  />
                </Section>

                <div ref={toolSectionRef}>
                  <Section
                    number="04 / 05"
                    kicker={`TOOLS · ${enabledTools.length} ENABLED`}
                    title="Available tool registry"
                    sub="Enabling any tool runs the agent through the tool-use loop on save."
                  >
                    <ToolPicker
                      tools={availableTools}
                      enabled={enabledTools}
                      onChange={updateEnabledTools}
                    />
                  </Section>
                </div>

                <Section
                  number="05 / 05"
                  kicker="MEMORY · INPUTS · EVALUATION"
                  title="First-run contract"
                  sub="Bounded non-secret context, saved input examples, and deterministic evaluation expectations."
                >
                  <div className="kicker" style={{ marginBottom: 8 }}>
                    MEMORY
                  </div>
                  <MemoryEditor memory={memory} onChange={setMemory} />
                  <div
                    className="kicker"
                    style={{
                      marginTop: 16,
                      paddingTop: 16,
                      borderTop: "1px solid var(--line)",
                      marginBottom: 8,
                    }}
                  >
                    INPUT SCHEMA & EXAMPLES
                  </div>
                  <InputSchemaEditor schema={inputSchema} onChange={updateInputSchema} />
                  <div
                    style={{
                      marginTop: 16,
                      paddingTop: 16,
                      borderTop: "1px solid var(--line)",
                    }}
                  >
                    <Field label="Expected output · operator review context">
                      <textarea
                        className="field"
                        rows={3}
                        maxLength={1_200}
                        value={evaluationExpectedOutput}
                        onChange={(event) => setEvaluationExpectedOutput(event.target.value)}
                      />
                    </Field>
                    <div className="label" style={{ marginTop: 10 }}>
                      Required successful tool calls
                    </div>
                    {enabledTools.length === 0 ? (
                      <div className="mono muted" style={{ fontSize: 11 }}>
                        No enabled tool is required.
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {enabledTools.map((tool) => (
                          <label
                            key={tool}
                            className="mono"
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              fontSize: 11,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={evaluationTools.includes(tool)}
                              onChange={(event) =>
                                setEvaluationTools((current) =>
                                  event.target.checked
                                    ? Array.from(new Set([...current, tool]))
                                    : current.filter((candidate) => candidate !== tool),
                                )
                              }
                            />
                            {tool}
                          </label>
                        ))}
                      </div>
                    )}
                    <p className="mono muted" style={{ fontSize: 10.5, marginTop: 8 }}>
                      Pass/fail is structural: saved input example, successful bounded run,
                      non-empty output, and these tool calls. Expected-output text is shown for
                      review, not graded by a second model.
                    </p>
                  </div>
                </Section>

                <div
                  style={{
                    marginTop: 18,
                    paddingTop: 16,
                    borderTop: "1px solid var(--line)",
                    display: "flex",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={!canManageAgent || saving}
                  >
                    {saving ? (
                      <span className="spin">
                        <I.refresh size={13} />
                      </span>
                    ) : (
                      <I.check size={13} />
                    )}
                    {isNew ? " Create agent" : " Save agent"}
                  </button>
                </div>
              </fieldset>
            </form>

            <AgentRunSidebar
              isNew={isNew}
              agent={agent}
              inputSchema={inputSchema}
              runInputs={runInputs}
              canRunAgent={canRunAgent}
              canManageAgent={canManageAgent}
              running={running}
              saving={saving}
              firstRunEvaluationPending={firstRunEvaluationPending}
              pendingApproval={pendingApproval}
              runs={runs}
              expandedRun={expandedRun}
              playbookReviewRunId={playbookReviewRunId}
              recordingRunId={recordingRunId}
              playbook={playbook}
              updateRunInputValue={updateRunInputValue}
              runNow={runNow}
              launchPendingApproval={launchPendingApproval}
              editPendingTools={editPendingTools}
              cancelPendingApproval={cancelPendingApproval}
              setExpandedRun={setExpandedRun}
              setPlaybookReviewRunId={setPlaybookReviewRunId}
              recordAsPlaybook={recordAsPlaybook}
            />
          </div>
        )}
      </div>
    </>
  );
}
