import type { ActivationSignalSnapshot } from "./domain";

export interface WorkspaceActivationFacts {
  now: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  releasedAt?: string;
  briefCapturedAt?: string;
  requirementsDefinedAt?: string;
  planDefinedAt?: string;
  implementationStartedAt?: string;
  testsPassedAt?: string;
  validationPassedAt?: string;
  releaseConfirmedAt?: string;
  blockerCount?: number;
  dependencyBlockerCount?: number;
  openQuestionCount?: number;
  criticalIssueCount?: number;
  scopeChangeCount?: number;
  failedValidationCount?: number;
  retryCount?: number;
}

export interface DurableActivationProductRecord {
  id?: string;
  kind?: string;
  status?: string;
  severity?: string;
  blockerType?: string;
  evidenceType?: string;
  category?: string;
  dependency?: boolean;
  createdAt?: string;
  updatedAt?: string;
  capturedAt?: string;
  definedAt?: string;
  plannedAt?: string;
  startedAt?: string;
  completedAt?: string;
  confirmedAt?: string;
  releasedAt?: string;
  passedAt?: string;
  failedAt?: string;
  resolvedAt?: string;
}

export type DurableActivationProductRecordList =
  | DurableActivationProductRecord
  | DurableActivationProductRecord[]
  | null
  | undefined;

export interface DurableActivationProductRecords {
  now: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  releasedAt?: string;
  brief?: DurableActivationProductRecord | null;
  requirements?: DurableActivationProductRecordList;
  plan?: DurableActivationProductRecord | null;
  implementation?: DurableActivationProductRecord | null;
  blockers?: DurableActivationProductRecord[];
  questions?: DurableActivationProductRecord[];
  validationEvidence?: DurableActivationProductRecord[];
  testEvidence?: DurableActivationProductRecord[];
  releaseConfirmation?: DurableActivationProductRecord | null;
  retries?: DurableActivationProductRecord[];
  scopeChanges?: DurableActivationProductRecord[];
}

export function buildSignalSnapshotFromFacts(
  facts: WorkspaceActivationFacts,
): ActivationSignalSnapshot {
  return {
    now: facts.now,
    createdAt: facts.createdAt,
    startedAt: facts.startedAt ?? facts.implementationStartedAt,
    completedAt: facts.completedAt,
    releasedAt: facts.releasedAt ?? facts.releaseConfirmedAt,
    hasBrief: Boolean(facts.briefCapturedAt),
    hasRequirements: Boolean(facts.requirementsDefinedAt),
    hasPlan: Boolean(facts.planDefinedAt),
    hasImplementation: Boolean(facts.implementationStartedAt || facts.completedAt),
    hasTests: Boolean(facts.testsPassedAt),
    hasValidationEvidence: Boolean(facts.validationPassedAt),
    hasReleaseEvidence: Boolean(facts.releaseConfirmedAt),
    blockerCount: facts.blockerCount ?? 0,
    dependencyBlockerCount: facts.dependencyBlockerCount ?? 0,
    openQuestionCount: facts.openQuestionCount ?? 0,
    criticalIssueCount: facts.criticalIssueCount ?? 0,
    scopeChangeCount: facts.scopeChangeCount ?? 0,
    failedValidationCount: facts.failedValidationCount ?? 0,
    retryCount: facts.retryCount ?? 0,
  };
}

export function buildSignalSnapshotFromProductRecords(
  records: DurableActivationProductRecords,
): ActivationSignalSnapshot {
  const requirements = toRecordArray(records.requirements).filter(isUsableRecord);
  const plan = records.plan && isUsableRecord(records.plan) ? records.plan : undefined;
  const implementation =
    records.implementation && isUsableRecord(records.implementation)
      ? records.implementation
      : undefined;
  const validationEvidence = (records.validationEvidence ?? []).filter(isUsableRecord);
  const testEvidence = (records.testEvidence ?? []).filter(isUsableRecord);
  const releaseConfirmation =
    records.releaseConfirmation && isConfirmedReleaseRecord(records.releaseConfirmation)
      ? records.releaseConfirmation
      : undefined;
  const activeBlockers = (records.blockers ?? []).filter(isActiveRecord);
  const openQuestions = (records.questions ?? []).filter(isOpenQuestion);
  const passedValidationEvidence = validationEvidence.filter((record) => !isFailedRecord(record));
  const passedTestEvidence = testEvidence.filter((record) => !isFailedRecord(record));

  return buildSignalSnapshotFromFacts({
    now: records.now,
    createdAt:
      records.createdAt ??
      earliestTimestamp([
        records.brief,
        ...requirements,
        plan,
        implementation,
        ...validationEvidence,
        ...testEvidence,
        releaseConfirmation,
      ]),
    startedAt:
      records.startedAt ??
      firstTimestamp(implementation, ["startedAt", "createdAt"]) ??
      startedAtFromPlan(plan),
    completedAt:
      records.completedAt ??
      firstTimestamp(implementation, ["completedAt"]) ??
      firstTimestamp(firstRecord(passedValidationEvidence), [
        "completedAt",
        "passedAt",
        "confirmedAt",
      ]),
    releasedAt:
      records.releasedAt ??
      firstTimestamp(releaseConfirmation, ["releasedAt", "confirmedAt", "completedAt"]),
    briefCapturedAt: productSignalTimestamp(
      records.brief,
      ["capturedAt", "createdAt", "updatedAt"],
      records.now,
    ),
    requirementsDefinedAt: productSignalTimestamp(
      firstRecord(requirements),
      ["definedAt", "completedAt", "createdAt", "updatedAt"],
      records.now,
    ),
    planDefinedAt: productSignalTimestamp(
      plan,
      ["plannedAt", "definedAt", "createdAt", "updatedAt"],
      records.now,
    ),
    implementationStartedAt:
      productSignalTimestamp(implementation, ["startedAt", "createdAt"], records.now) ??
      startedAtFromPlan(plan),
    testsPassedAt: productSignalTimestamp(
      firstRecord(passedTestEvidence) ??
        firstRecord(passedValidationEvidence.filter(isTestEvidence)),
      ["passedAt", "completedAt", "confirmedAt", "createdAt"],
      records.now,
    ),
    validationPassedAt: productSignalTimestamp(
      firstRecord(passedValidationEvidence),
      ["passedAt", "completedAt", "confirmedAt", "createdAt"],
      records.now,
    ),
    releaseConfirmedAt: productSignalTimestamp(
      releaseConfirmation,
      ["confirmedAt", "releasedAt", "completedAt", "createdAt"],
      records.now,
    ),
    blockerCount: activeBlockers.length,
    dependencyBlockerCount: activeBlockers.filter(isDependencyBlocker).length,
    openQuestionCount: openQuestions.length,
    criticalIssueCount:
      activeBlockers.filter(isCriticalRecord).length +
      validationEvidence.filter((record) => isFailedRecord(record) && isCriticalRecord(record))
        .length,
    scopeChangeCount: (records.scopeChanges ?? []).filter(isUsableRecord).length,
    failedValidationCount: validationEvidence.filter(isFailedRecord).length,
    retryCount: (records.retries ?? []).filter(isUsableRecord).length,
  });
}

function toRecordArray(
  records: DurableActivationProductRecordList,
): DurableActivationProductRecord[] {
  if (!records) return [];
  return Array.isArray(records) ? records : [records];
}

function firstRecord(
  records: DurableActivationProductRecord[],
): DurableActivationProductRecord | undefined {
  return records[0];
}

function isUsableRecord(
  record: DurableActivationProductRecord | null | undefined,
): record is DurableActivationProductRecord {
  if (!record) return false;
  return !["cancelled", "canceled", "discarded", "superseded"].includes(normalize(record.status));
}

function isActiveRecord(record: DurableActivationProductRecord): boolean {
  if (!isUsableRecord(record)) return false;
  return (
    !["resolved", "closed", "done", "completed"].includes(normalize(record.status)) &&
    !record.resolvedAt
  );
}

function isOpenQuestion(record: DurableActivationProductRecord): boolean {
  if (!isUsableRecord(record)) return false;
  return (
    !["answered", "resolved", "closed", "done", "completed"].includes(normalize(record.status)) &&
    !record.resolvedAt
  );
}

function isFailedRecord(record: DurableActivationProductRecord): boolean {
  return (
    Boolean(record.failedAt) || ["failed", "rejected", "error"].includes(normalize(record.status))
  );
}

function isConfirmedReleaseRecord(record: DurableActivationProductRecord): boolean {
  if (!isUsableRecord(record)) return false;
  return (
    Boolean(record.confirmedAt || record.releasedAt || record.completedAt) ||
    ["confirmed", "released", "completed", "done"].includes(normalize(record.status))
  );
}

function isCriticalRecord(record: DurableActivationProductRecord): boolean {
  return normalize(record.severity) === "critical";
}

function isDependencyBlocker(record: DurableActivationProductRecord): boolean {
  return (
    record.dependency === true ||
    normalize(record.blockerType) === "dependency" ||
    normalize(record.kind) === "dependency_blocker"
  );
}

function isTestEvidence(record: DurableActivationProductRecord): boolean {
  return [record.kind, record.evidenceType, record.category].some((value) => {
    const normalized = normalize(value);
    return normalized === "test" || normalized === "tests" || normalized === "qa";
  });
}

function startedAtFromPlan(plan: DurableActivationProductRecord | undefined): string | undefined {
  if (!plan) return undefined;
  const status = normalize(plan.status);
  if (!["started", "in_progress", "complete", "completed", "done"].includes(status)) {
    return undefined;
  }

  return firstTimestamp(plan, ["startedAt", "updatedAt", "createdAt"]);
}

function productSignalTimestamp(
  record: DurableActivationProductRecord | null | undefined,
  fields: Array<keyof DurableActivationProductRecord>,
  fallback: string,
): string | undefined {
  if (!isUsableRecord(record)) return undefined;
  return firstTimestamp(record, fields) ?? fallback;
}

function firstTimestamp(
  record: DurableActivationProductRecord | null | undefined,
  fields: Array<keyof DurableActivationProductRecord>,
): string | undefined {
  if (!record) return undefined;

  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }

  return undefined;
}

function earliestTimestamp(
  records: Array<DurableActivationProductRecord | null | undefined>,
): string | undefined {
  return records
    .flatMap((record) => {
      if (!record) return [];
      return [
        record.createdAt,
        record.capturedAt,
        record.definedAt,
        record.plannedAt,
        record.startedAt,
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
    })
    .sort()[0];
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
