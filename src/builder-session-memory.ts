export type BuilderPromptTurnRole = "user" | "assistant" | "system";
export type BuilderPromptTurnKind =
  | "prompt"
  | "clarification"
  | "regenerate"
  | "refine"
  | "decision"
  | "status";
export type BuilderDecisionStatus = "pending" | "accepted" | "rejected";
export type BuilderClarifyQuestionStatus = "open" | "answered" | "dismissed";
export type BuilderRegenerateScope =
  | "full_plan"
  | "agent"
  | "app"
  | "page"
  | "data_model"
  | "workflow"
  | "acceptance_checks";
export type BuilderCandidateStatus =
  | "none"
  | "drafting"
  | "needs_clarification"
  | "ready"
  | "applied"
  | "failed";
export type BuilderNextActionKind =
  | "collect_prompt"
  | "answer_clarifications"
  | "retry_or_regenerate"
  | "regenerate_candidate"
  | "generate_candidate"
  | "review_decisions"
  | "approve_or_refine"
  | "continue_iteration";

export type BuilderPromptTurnInput = {
  id?: string;
  role: BuilderPromptTurnRole;
  content?: string;
  kind?: BuilderPromptTurnKind;
  createdAt?: string;
  candidateId?: string;
};

export type BuilderPromptTurn = {
  id: string;
  role: BuilderPromptTurnRole;
  content: string;
  kind: BuilderPromptTurnKind;
  createdAt?: string;
  candidateId?: string;
};

export type BuilderDecisionInput = {
  id?: string;
  label?: string;
  value?: string;
  status?: BuilderDecisionStatus;
  rationale?: string;
  sourceTurnId?: string;
  createdAt?: string;
};

export type BuilderDecision = {
  id: string;
  label: string;
  value: string;
  status: BuilderDecisionStatus;
  rationale?: string;
  sourceTurnId?: string;
  createdAt?: string;
};

export type BuilderProjectMemoryFactInput = {
  id?: string;
  key?: string;
  value?: string;
  source?: string;
  confidence?: number;
  pinned?: boolean;
  updatedAt?: string;
};

export type BuilderProjectMemoryFact = {
  id: string;
  key: string;
  value: string;
  source?: string;
  confidence: number;
  pinned: boolean;
  updatedAt?: string;
};

export type BuilderClarifyQuestionInput = {
  id?: string;
  question?: string;
  status?: BuilderClarifyQuestionStatus;
  answer?: string;
  reason?: string;
  askedAt?: string;
};

export type BuilderClarifyQuestion = {
  id: string;
  question: string;
  status: BuilderClarifyQuestionStatus;
  answer?: string;
  reason?: string;
  askedAt?: string;
};

export type BuilderRegenerateOptionInput = {
  id?: string;
  label?: string;
  scope?: BuilderRegenerateScope;
  instruction?: string;
  selected?: boolean;
  reason?: string;
};

export type BuilderRegenerateOption = {
  id: string;
  label: string;
  scope: BuilderRegenerateScope;
  instruction: string;
  selected: boolean;
  reason?: string;
};

export type BuilderCandidateInput = {
  id?: string;
  status?: BuilderCandidateStatus;
  summary?: string;
};

export type BuilderSessionMemoryInput = {
  sessionId: string;
  title?: string;
  promptTurns?: BuilderPromptTurnInput[];
  decisions?: BuilderDecisionInput[];
  projectMemoryFacts?: BuilderProjectMemoryFactInput[];
  clarifyQuestions?: BuilderClarifyQuestionInput[];
  regenerateOptions?: BuilderRegenerateOptionInput[];
  candidate?: BuilderCandidateInput;
};

export type BuilderNextActionGuidance = {
  kind: BuilderNextActionKind;
  label: string;
  guidance: string;
  blockingQuestionIds: string[];
  selectedRegenerateOptionIds: string[];
};

export type BuilderSessionMemory = {
  version: "phase-72-lane-1";
  session: {
    id: string;
    title: string;
    promptTurnCount: number;
    latestTurnId?: string;
  };
  promptTurns: BuilderPromptTurn[];
  decisions: BuilderDecision[];
  projectMemoryFacts: BuilderProjectMemoryFact[];
  clarifyQuestions: BuilderClarifyQuestion[];
  regenerateOptions: BuilderRegenerateOption[];
  candidate: {
    id?: string;
    status: BuilderCandidateStatus;
    summary?: string;
  };
  nextAction: BuilderNextActionGuidance;
  promptContext: string;
};

const DEFAULT_SESSION_TITLE = "Untitled builder session";
const MAX_CLARIFY_QUESTIONS = 3;
const DEFAULT_CANDIDATE_STATUS: BuilderCandidateStatus = "none";

export function buildBuilderSessionMemory(input: BuilderSessionMemoryInput): BuilderSessionMemory {
  const promptTurns = normalizePromptTurns(input.promptTurns ?? []);
  const decisions = normalizeDecisions(input.decisions ?? []);
  const projectMemoryFacts = normalizeProjectMemoryFacts(input.projectMemoryFacts ?? []);
  const clarifyQuestions = normalizeClarifyQuestions(input.clarifyQuestions ?? []);
  const regenerateOptions = normalizeRegenerateOptions(input.regenerateOptions ?? []);
  const candidate = removeUndefined({
    id: cleanString(input.candidate?.id) || undefined,
    status: input.candidate?.status ?? DEFAULT_CANDIDATE_STATUS,
    summary: cleanString(input.candidate?.summary) || undefined,
  });
  const sessionTitle =
    cleanString(input.title) || titleFromPromptTurns(promptTurns) || DEFAULT_SESSION_TITLE;
  const nextAction = deriveBuilderNextAction({
    promptTurns,
    decisions,
    clarifyQuestions,
    regenerateOptions,
    candidate,
  });

  return {
    version: "phase-72-lane-1",
    session: removeUndefined({
      id: cleanString(input.sessionId) || "builder-session",
      title: sessionTitle,
      promptTurnCount: promptTurns.length,
      latestTurnId: promptTurns.at(-1)?.id,
    }),
    promptTurns,
    decisions,
    projectMemoryFacts,
    clarifyQuestions,
    regenerateOptions,
    candidate,
    nextAction,
    promptContext: buildPromptMemoryContext({
      sessionTitle,
      promptTurns,
      decisions,
      projectMemoryFacts,
      clarifyQuestions,
      regenerateOptions,
      nextAction,
    }),
  };
}

export function deriveBuilderNextAction(
  input: {
    promptTurns?: BuilderPromptTurn[];
    decisions?: BuilderDecision[];
    clarifyQuestions?: BuilderClarifyQuestion[];
    regenerateOptions?: BuilderRegenerateOption[];
    candidate?: BuilderCandidateInput;
  } = {},
): BuilderNextActionGuidance {
  const promptTurns = input.promptTurns ?? [];
  const openQuestions = (input.clarifyQuestions ?? []).filter(
    (question) => question.status === "open",
  );
  const selectedRegenerateOptions = (input.regenerateOptions ?? []).filter(
    (option) => option.selected,
  );
  const pendingDecisions = (input.decisions ?? []).filter(
    (decision) => decision.status === "pending",
  );
  const candidateStatus = input.candidate?.status ?? DEFAULT_CANDIDATE_STATUS;
  const hasUserPrompt = promptTurns.some((turn) => turn.role === "user" && turn.content.length > 0);

  if (!hasUserPrompt) {
    return nextAction(
      "collect_prompt",
      "Collect prompt",
      "Ask the user what they want to build before planning.",
      [],
      [],
    );
  }

  if (openQuestions.length > 0 || candidateStatus === "needs_clarification") {
    return nextAction(
      "answer_clarifications",
      "Answer clarifying questions",
      "Collect answers for the open clarification questions, then regenerate the candidate from the same session memory.",
      openQuestions.map((question) => question.id),
      [],
    );
  }

  if (candidateStatus === "failed") {
    return nextAction(
      "retry_or_regenerate",
      "Retry or regenerate",
      "Keep the latest successful memory visible and retry the failed candidate or regenerate with a narrower option.",
      [],
      selectedRegenerateOptions.map((option) => option.id),
    );
  }

  if (selectedRegenerateOptions.length > 0) {
    return nextAction(
      "regenerate_candidate",
      "Regenerate candidate",
      "Regenerate only the selected scope while preserving prompt turns, decisions, and project memory facts.",
      [],
      selectedRegenerateOptions.map((option) => option.id),
    );
  }

  if (candidateStatus === "none") {
    return nextAction(
      "generate_candidate",
      "Generate candidate",
      "Create the first dry-run candidate from the saved prompt session.",
      [],
      [],
    );
  }

  if (pendingDecisions.length > 0) {
    return nextAction(
      "review_decisions",
      "Review decisions",
      "Resolve pending builder decisions before apply or publish.",
      [],
      [],
    );
  }

  if (candidateStatus === "ready") {
    return nextAction(
      "approve_or_refine",
      "Approve or refine",
      "Approve the current candidate or ask for a scoped refinement.",
      [],
      [],
    );
  }

  return nextAction(
    "continue_iteration",
    "Continue iteration",
    "Use the saved session memory for the next prompt, preview fix, or publish step.",
    [],
    [],
  );
}

function normalizePromptTurns(turns: BuilderPromptTurnInput[]): BuilderPromptTurn[] {
  const normalized: BuilderPromptTurn[] = [];
  turns.forEach((turn, index) => {
    const content = cleanString(turn.content);
    if (!content) return;
    normalized.push(
      removeUndefined({
        id: cleanString(turn.id) || `turn-${index + 1}`,
        role: turn.role,
        content,
        kind: turn.kind ?? "prompt",
        createdAt: cleanString(turn.createdAt) || undefined,
        candidateId: cleanString(turn.candidateId) || undefined,
      }) as BuilderPromptTurn,
    );
  });
  return normalized.sort(compareTimelineRecords);
}

function normalizeDecisions(decisions: BuilderDecisionInput[]): BuilderDecision[] {
  const normalized: BuilderDecision[] = [];
  decisions.forEach((decision, index) => {
    const label = cleanString(decision.label);
    const value = cleanString(decision.value);
    if (!label && !value) return;
    normalized.push(
      removeUndefined({
        id: cleanString(decision.id) || `decision-${index + 1}`,
        label: label || "Builder decision",
        value: value || "Not specified",
        status: decision.status ?? "accepted",
        rationale: cleanString(decision.rationale) || undefined,
        sourceTurnId: cleanString(decision.sourceTurnId) || undefined,
        createdAt: cleanString(decision.createdAt) || undefined,
      }) as BuilderDecision,
    );
  });
  return normalized.sort(compareTimelineRecords);
}

function normalizeProjectMemoryFacts(
  facts: BuilderProjectMemoryFactInput[],
): BuilderProjectMemoryFact[] {
  const byKey = new Map<string, BuilderProjectMemoryFact>();

  facts.forEach((fact, index) => {
    const key = cleanString(fact.key);
    const value = cleanString(fact.value);
    if (!key || !value) return;

    const normalized = removeUndefined({
      id: cleanString(fact.id) || `memory-${stableKey(key) || index + 1}`,
      key,
      value,
      source: cleanString(fact.source) || undefined,
      confidence: clampConfidence(fact.confidence),
      pinned: fact.pinned === true,
      updatedAt: cleanString(fact.updatedAt) || undefined,
    });
    const existing = byKey.get(key.toLowerCase());
    if (!existing || compareMemoryFactPriority(normalized, existing) < 0) {
      byKey.set(key.toLowerCase(), normalized);
    }
  });

  return [...byKey.values()].sort(compareMemoryFacts);
}

function normalizeClarifyQuestions(
  questions: BuilderClarifyQuestionInput[],
): BuilderClarifyQuestion[] {
  const normalized: BuilderClarifyQuestion[] = [];
  questions.forEach((question, index) => {
    const text = cleanString(question.question);
    if (!text) return;
    const answer = cleanString(question.answer);
    normalized.push(
      removeUndefined({
        id: cleanString(question.id) || `clarify-${index + 1}`,
        question: text,
        status: question.status ?? (answer ? "answered" : "open"),
        answer: answer || undefined,
        reason: cleanString(question.reason) || undefined,
        askedAt: cleanString(question.askedAt) || undefined,
      }) as BuilderClarifyQuestion,
    );
  });
  return normalized.sort(compareClarifyQuestions).slice(0, MAX_CLARIFY_QUESTIONS);
}

function normalizeRegenerateOptions(
  options: BuilderRegenerateOptionInput[],
): BuilderRegenerateOption[] {
  const normalized: BuilderRegenerateOption[] = [];
  options.forEach((option, index) => {
    const label = cleanString(option.label);
    const instruction = cleanString(option.instruction);
    if (!label && !instruction) return;
    normalized.push(
      removeUndefined({
        id: cleanString(option.id) || `regenerate-${index + 1}`,
        label: label || "Regenerate candidate",
        scope: option.scope ?? "full_plan",
        instruction:
          instruction || "Regenerate the current candidate using the saved session memory.",
        selected: option.selected === true,
        reason: cleanString(option.reason) || undefined,
      }) as BuilderRegenerateOption,
    );
  });
  return normalized.sort(
    (left, right) =>
      left.scope.localeCompare(right.scope) ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id),
  );
}

function buildPromptMemoryContext(input: {
  sessionTitle: string;
  promptTurns: BuilderPromptTurn[];
  decisions: BuilderDecision[];
  projectMemoryFacts: BuilderProjectMemoryFact[];
  clarifyQuestions: BuilderClarifyQuestion[];
  regenerateOptions: BuilderRegenerateOption[];
  nextAction: BuilderNextActionGuidance;
}): string {
  const lines = [
    `Session: ${input.sessionTitle}`,
    section(
      "Prompt turns",
      input.promptTurns.map((turn) => `${turn.id} [${turn.role}/${turn.kind}]: ${turn.content}`),
    ),
    section(
      "Decisions",
      input.decisions.map(
        (decision) => `${decision.id} [${decision.status}]: ${decision.label} = ${decision.value}`,
      ),
    ),
    section(
      "Project memory",
      input.projectMemoryFacts.map((fact) => `${fact.key}: ${fact.value}`),
    ),
    section(
      "Clarifying questions",
      input.clarifyQuestions.map(
        (question) =>
          `${question.id} [${question.status}]: ${question.question}${question.answer ? ` Answer: ${question.answer}` : ""}`,
      ),
    ),
    section(
      "Regenerate options",
      input.regenerateOptions.map(
        (option) =>
          `${option.id} [${option.scope}${option.selected ? ", selected" : ""}]: ${option.instruction}`,
      ),
    ),
    `Next action: ${input.nextAction.label}. ${input.nextAction.guidance}`,
  ];

  return lines.filter(Boolean).join("\n");
}

function section(label: string, values: string[]): string {
  return values.length > 0 ? `${label}:\n${values.map((value) => `- ${value}`).join("\n")}` : "";
}

function nextAction(
  kind: BuilderNextActionKind,
  label: string,
  guidance: string,
  blockingQuestionIds: string[],
  selectedRegenerateOptionIds: string[],
): BuilderNextActionGuidance {
  return {
    kind,
    label,
    guidance,
    blockingQuestionIds: [...blockingQuestionIds].sort(),
    selectedRegenerateOptionIds: [...selectedRegenerateOptionIds].sort(),
  };
}

function titleFromPromptTurns(turns: BuilderPromptTurn[]): string | undefined {
  const firstUserPrompt = turns.find((turn) => turn.role === "user")?.content;
  if (!firstUserPrompt) return undefined;
  return firstUserPrompt.length > 64
    ? `${firstUserPrompt.slice(0, 61).trim()}...`
    : firstUserPrompt;
}

function compareTimelineRecords(
  left: { id: string; createdAt?: string },
  right: { id: string; createdAt?: string },
): number {
  return compareOptionalStrings(left.createdAt, right.createdAt) || left.id.localeCompare(right.id);
}

function compareMemoryFacts(
  left: BuilderProjectMemoryFact,
  right: BuilderProjectMemoryFact,
): number {
  return (
    Number(right.pinned) - Number(left.pinned) ||
    right.confidence - left.confidence ||
    left.key.localeCompare(right.key) ||
    left.id.localeCompare(right.id)
  );
}

function compareMemoryFactPriority(
  left: BuilderProjectMemoryFact,
  right: BuilderProjectMemoryFact,
): number {
  return (
    Number(right.pinned) - Number(left.pinned) ||
    right.confidence - left.confidence ||
    compareOptionalStrings(right.updatedAt, left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareClarifyQuestions(
  left: BuilderClarifyQuestion,
  right: BuilderClarifyQuestion,
): number {
  return (
    clarifyStatusRank(left.status) - clarifyStatusRank(right.status) ||
    compareOptionalStrings(left.askedAt, right.askedAt) ||
    left.id.localeCompare(right.id)
  );
}

function clarifyStatusRank(status: BuilderClarifyQuestionStatus): number {
  return status === "open" ? 0 : status === "answered" ? 1 : 2;
}

function compareOptionalStrings(left: string | undefined, right: string | undefined): number {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function stableKey(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_/-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "fact"
  );
}

function cleanString(value: string | undefined): string {
  return String(value ?? "").trim();
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
