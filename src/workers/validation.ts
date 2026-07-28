import { createHash } from "node:crypto";
import { parseCron } from "../jobs/cron.js";
import {
  WORKER_CONTRACT_SCHEMA_VERSION,
  type WorkerActorReference,
  type WorkerCheckpoint,
  type WorkerDefinition,
  type WorkerDeployment,
  type WorkerRun,
  type WorkerRunStatus,
  type WorkerRunTerminalReason,
  type WorkerPolicy,
  type WorkerSourceProvenance,
  type WorkerToolCapability,
  type WorkerTrigger,
  type WorkerVersion,
  type WorkerVersionContent,
} from "./types.js";

export interface WorkerContractIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type WorkerContractValidation<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly [] }
  | { readonly ok: false; readonly issues: readonly WorkerContractIssue[] };

export class WorkerContractValidationError extends Error {
  readonly issues: readonly WorkerContractIssue[];

  constructor(recordName: string, issues: readonly WorkerContractIssue[]) {
    super(
      `${recordName} is invalid: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    );
    this.name = "WorkerContractValidationError";
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;
type IssueCollector = WorkerContractIssue[];

const DEFINITION_STATUSES = ["draft", "active", "retired"] as const;
const VERSION_STATUSES = ["draft", "validated", "rejected", "retired"] as const;
const DEPLOYMENT_STATUSES = [
  "draft",
  "validated",
  "deployed",
  "active",
  "paused",
  "attention",
  "retired",
  "rejected",
  "revoked",
] as const;
const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_for_approval",
  "paused",
  "completed",
  "failed",
  "budget_exhausted",
  "cancelled",
  "quarantined",
] as const;
const TERMINAL_RUN_STATUSES: ReadonlySet<WorkerRunStatus> = new Set([
  "completed",
  "failed",
  "budget_exhausted",
  "cancelled",
  "quarantined",
]);
const TERMINAL_REASONS_BY_STATUS: Readonly<
  Record<WorkerRunStatus, readonly WorkerRunTerminalReason[]>
> = {
  queued: [],
  running: [],
  waiting_for_approval: [],
  paused: [],
  completed: ["objective_satisfied", "exit_predicate_matched"],
  failed: ["failure_limit", "unhandled_error"],
  budget_exhausted: ["elapsed_time", "iteration_limit", "provider_cost", "tool_call_limit"],
  cancelled: ["operator_cancelled", "deployment_revoked", "lease_lost"],
  quarantined: ["unsafe_replay"],
};

function issue(issues: IssueCollector, path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, path: string, issues: IssueCollector): UnknownRecord | null {
  if (!isRecord(value)) {
    issue(issues, path, "type.object", "must be an object");
    return null;
  }
  return value;
}

function stringAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: IssueCollector,
  options: { optional?: boolean; minLength?: number } = {},
): string | undefined {
  const value = record[key];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") {
    issue(issues, `${path}.${key}`, "type.string", "must be a string");
    return undefined;
  }
  const minLength = options.minLength ?? 1;
  if (value.trim().length < minLength) {
    issue(
      issues,
      `${path}.${key}`,
      "string.non_empty",
      `must contain at least ${minLength} non-whitespace character(s)`,
    );
  }
  return value;
}

function booleanAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: IssueCollector,
): boolean | undefined {
  const value = record[key];
  if (typeof value !== "boolean") {
    issue(issues, `${path}.${key}`, "type.boolean", "must be a boolean");
    return undefined;
  }
  return value;
}

function numberAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: IssueCollector,
  options: { integer?: boolean; minimum?: number; exclusiveMinimum?: number } = {},
): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issue(issues, `${path}.${key}`, "type.number", "must be a finite number");
    return undefined;
  }
  if (options.integer && !Number.isInteger(value)) {
    issue(issues, `${path}.${key}`, "number.integer", "must be an integer");
  }
  if (options.minimum !== undefined && value < options.minimum) {
    issue(issues, `${path}.${key}`, "number.minimum", `must be at least ${options.minimum}`);
  }
  if (options.exclusiveMinimum !== undefined && value <= options.exclusiveMinimum) {
    issue(
      issues,
      `${path}.${key}`,
      "number.exclusive_minimum",
      `must be greater than ${options.exclusiveMinimum}`,
    );
  }
  return value;
}

function enumAt<T extends string>(
  record: UnknownRecord,
  key: string,
  values: readonly T[],
  path: string,
  issues: IssueCollector,
): T | undefined {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    issue(issues, `${path}.${key}`, "enum", `must be one of: ${values.join(", ")}`);
    return undefined;
  }
  return value as T;
}

function arrayAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: IssueCollector,
): readonly unknown[] | null {
  const value = record[key];
  if (!Array.isArray(value)) {
    issue(issues, `${path}.${key}`, "type.array", "must be an array");
    return null;
  }
  return value;
}

function optionalArrayAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: IssueCollector,
): readonly unknown[] | null {
  const value = record[key];
  if (value === undefined) return null;
  return arrayAt(record, key, path, issues);
}

function stringArrayAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: IssueCollector,
  options: { minLength?: number; unique?: boolean } = {},
): readonly string[] {
  const values = arrayAt(record, key, path, issues);
  if (!values) return [];
  if (options.minLength !== undefined && values.length < options.minLength) {
    issue(
      issues,
      `${path}.${key}`,
      "array.min_items",
      `must contain at least ${options.minLength} item(s)`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      issue(
        issues,
        `${path}.${key}[${index}]`,
        "type.non_empty_string",
        "must be a non-empty string",
      );
      return;
    }
    if (options.unique && seen.has(value)) {
      issue(
        issues,
        `${path}.${key}[${index}]`,
        "array.unique",
        `duplicates ${JSON.stringify(value)}`,
      );
      return;
    }
    seen.add(value);
    result.push(value);
  });
  return result;
}

function schemaVersionAt(record: UnknownRecord, path: string, issues: IssueCollector): void {
  if (record.schemaVersion !== WORKER_CONTRACT_SCHEMA_VERSION) {
    issue(
      issues,
      `${path}.schemaVersion`,
      "schema_version.unsupported",
      `must equal ${JSON.stringify(WORKER_CONTRACT_SCHEMA_VERSION)}`,
    );
  }
}

function timestampAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: IssueCollector,
  options: { optional?: boolean } = {},
): string | undefined {
  const value = stringAt(record, key, path, issues, options);
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    issue(
      issues,
      `${path}.${key}`,
      "timestamp.utc_iso",
      "must be a canonical UTC ISO-8601 timestamp",
    );
  }
  return value;
}

function validateActor(value: unknown, path: string, issues: IssueCollector): void {
  const actor = recordAt(value, path, issues);
  if (!actor) return;
  const type = enumAt(actor, "type", ["user", "system", "packet_product"], path, issues);
  stringAt(actor, "id", path, issues);
  stringAt(actor, "displayName", path, issues, { optional: true });
  const product = actor.product;
  if (product !== undefined) {
    enumAt(
      actor,
      "product",
      ["PacketADE", "PacketAgent", "PacketChat", "PacketCode", "PacketPhone"],
      path,
      issues,
    );
  }
  if (type === "packet_product" && product === undefined) {
    issue(
      issues,
      `${path}.product`,
      "actor.product_required",
      "is required for packet_product actors",
    );
  }
}

function validateProvenance(value: unknown, path: string, issues: IssueCollector): void {
  const source = recordAt(value, path, issues);
  if (!source) return;
  const product = enumAt(
    source,
    "product",
    ["PacketADE", "PacketAgent", "PacketChat", "PacketCode", "PacketPhone"],
    path,
    issues,
  );
  const kind = enumAt(
    source,
    "kind",
    ["native", "packetade", "legacy_agent", "legacy_workflow"],
    path,
    issues,
  );
  for (const key of [
    "sourceId",
    "flightId",
    "projectId",
    "conversationId",
    "repository",
    "revision",
  ]) {
    stringAt(source, key, path, issues, { optional: true });
  }
  if (kind === "packetade" && product !== "PacketADE") {
    issue(
      issues,
      `${path}.product`,
      "provenance.packetade_product",
      "must be PacketADE when kind is packetade",
    );
  }
  if (product === "PacketADE" && kind !== "packetade") {
    issue(
      issues,
      `${path}.kind`,
      "provenance.packetade_kind",
      "must be packetade when product is PacketADE",
    );
  }
  if ((kind === "legacy_agent" || kind === "legacy_workflow") && source.sourceId === undefined) {
    issue(
      issues,
      `${path}.sourceId`,
      "provenance.source_id_required",
      `is required for ${kind} provenance`,
    );
  }
  if (source.revision !== undefined && source.repository === undefined) {
    issue(
      issues,
      `${path}.repository`,
      "provenance.repository_required",
      "is required when revision is supplied",
    );
  }
}

function validateInputSchema(value: unknown, path: string, issues: IssueCollector): void {
  const schema = recordAt(value, path, issues);
  if (!schema) return;
  booleanAt(schema, "additionalProperties", path, issues);
  const fields = arrayAt(schema, "fields", path, issues);
  if (!fields) return;
  const seen = new Set<string>();
  fields.forEach((value, index) => {
    const fieldPath = `${path}.fields[${index}]`;
    const field = recordAt(value, fieldPath, issues);
    if (!field) return;
    const key = stringAt(field, "key", fieldPath, issues);
    if (key && !/^[A-Za-z0-9_]{1,40}$/.test(key)) {
      issue(
        issues,
        `${fieldPath}.key`,
        "input.key",
        "must use 1-40 letters, numbers, or underscores",
      );
    }
    if (key && seen.has(key)) {
      issue(issues, `${fieldPath}.key`, "input.duplicate_key", `duplicates ${JSON.stringify(key)}`);
    }
    if (key) seen.add(key);
    stringAt(field, "label", fieldPath, issues);
    const type = enumAt(
      field,
      "type",
      ["string", "number", "boolean", "url", "enum"],
      fieldPath,
      issues,
    );
    booleanAt(field, "required", fieldPath, issues);
    stringAt(field, "description", fieldPath, issues, { optional: true });
    const options = optionalArrayAt(field, "options", fieldPath, issues);
    if (options) {
      options.forEach((option, optionIndex) => {
        if (typeof option !== "string" || !option.trim()) {
          issue(
            issues,
            `${fieldPath}.options[${optionIndex}]`,
            "type.non_empty_string",
            "must be a non-empty string",
          );
        }
      });
    }
    if (type === "enum" && (!options || options.length === 0)) {
      issue(
        issues,
        `${fieldPath}.options`,
        "input.enum_options",
        "must contain at least one option for enum fields",
      );
    }
    if (field.defaultValue !== undefined) {
      validateJsonValue(field.defaultValue, `${fieldPath}.defaultValue`, issues);
      if (isRecord(field.defaultValue) || Array.isArray(field.defaultValue)) {
        issue(
          issues,
          `${fieldPath}.defaultValue`,
          "input.default_primitive",
          "must be a JSON primitive",
        );
      }
    }
  });
}

function validateExecution(value: unknown, path: string, issues: IssueCollector): void {
  const execution = recordAt(value, path, issues);
  if (!execution) return;
  stringAt(execution, "routeKey", path, issues);
  stringAt(execution, "providerId", path, issues, { optional: true });
  stringAt(execution, "model", path, issues, { optional: true });
  const target = recordAt(execution.target, `${path}.target`, issues);
  if (!target) return;
  const kind = enumAt(
    target,
    "kind",
    ["packetagent", "sandbox", "external"],
    `${path}.target`,
    issues,
  );
  stringAt(target, "reference", `${path}.target`, issues, { optional: true });
  if (kind === "external" && target.reference === undefined) {
    issue(
      issues,
      `${path}.target.reference`,
      "execution.reference_required",
      "is required for external targets",
    );
  }
}

function validateCapability(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string | undefined {
  const capability = recordAt(value, path, issues);
  if (!capability) return undefined;
  const id = stringAt(capability, "id", path, issues);
  stringAt(capability, "tool", path, issues);
  stringArrayAt(capability, "verbs", path, issues, { minLength: 1, unique: true });
  stringArrayAt(capability, "resources", path, issues, { minLength: 1, unique: true });
  enumAt(capability, "effect", ["read", "write", "execute"], path, issues);
  enumAt(capability, "approval", ["never", "always"], path, issues);
  return id;
}

function validatePolicy(
  value: unknown,
  declaredCapabilityIds: ReadonlySet<string>,
  path: string,
  issues: IssueCollector,
): void {
  const policy = recordAt(value, path, issues);
  if (!policy) return;

  const budgets = recordAt(policy.budgets, `${path}.budgets`, issues);
  if (budgets) {
    numberAt(budgets, "maxElapsedMs", `${path}.budgets`, issues, {
      integer: true,
      exclusiveMinimum: 0,
    });
    numberAt(budgets, "maxIterations", `${path}.budgets`, issues, {
      integer: true,
      exclusiveMinimum: 0,
    });
    numberAt(budgets, "maxProviderCostUsd", `${path}.budgets`, issues, { exclusiveMinimum: 0 });
    numberAt(budgets, "maxConsecutiveFailures", `${path}.budgets`, issues, {
      integer: true,
      exclusiveMinimum: 0,
    });
    numberAt(budgets, "maxToolCalls", `${path}.budgets`, issues, {
      integer: true,
      exclusiveMinimum: 0,
    });
  }

  const retry = recordAt(policy.retry, `${path}.retry`, issues);
  if (retry) {
    numberAt(retry, "maxAttempts", `${path}.retry`, issues, { integer: true, minimum: 0 });
    const initialBackoff = numberAt(retry, "initialBackoffMs", `${path}.retry`, issues, {
      integer: true,
      minimum: 0,
    });
    const maxBackoff = numberAt(retry, "maxBackoffMs", `${path}.retry`, issues, {
      integer: true,
      minimum: 0,
    });
    numberAt(retry, "backoffMultiplier", `${path}.retry`, issues, { minimum: 1 });
    if (initialBackoff !== undefined && maxBackoff !== undefined && maxBackoff < initialBackoff) {
      issue(
        issues,
        `${path}.retry.maxBackoffMs`,
        "retry.backoff_order",
        "must be at least initialBackoffMs",
      );
    }
  }

  const permissions = recordAt(policy.permissions, `${path}.permissions`, issues);
  if (permissions) {
    if (permissions.default !== "deny") {
      issue(issues, `${path}.permissions.default`, "permissions.default_deny", "must be deny");
    }
    const allowed = stringArrayAt(
      permissions,
      "allowedCapabilityIds",
      `${path}.permissions`,
      issues,
      {
        unique: true,
      },
    );
    allowed.forEach((id, index) => {
      if (!declaredCapabilityIds.has(id)) {
        issue(
          issues,
          `${path}.permissions.allowedCapabilityIds[${index}]`,
          "permissions.unknown_capability",
          `references undeclared capability ${JSON.stringify(id)}`,
        );
      }
    });
  }
}

function unexpectedKeys(
  record: UnknownRecord,
  allowed: ReadonlySet<string>,
  path: string,
  issues: IssueCollector,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issue(
        issues,
        `${path}.${key}`,
        "object.unexpected_field",
        `is not valid for trigger kind ${JSON.stringify(record.kind)}`,
      );
    }
  }
}

function validateTrigger(value: unknown, path: string, issues: IssueCollector): string | undefined {
  const trigger = recordAt(value, path, issues);
  if (!trigger) return undefined;
  const id = stringAt(trigger, "id", path, issues);
  const kind = enumAt(
    trigger,
    "kind",
    ["manual", "cron", "webhook", "queue", "alert"],
    path,
    issues,
  );
  booleanAt(trigger, "enabled", path, issues);
  stringAt(trigger, "description", path, issues, { optional: true });

  const baseKeys = ["id", "kind", "enabled", "description"];
  if (kind === "manual") {
    unexpectedKeys(trigger, new Set(baseKeys), path, issues);
  } else if (kind === "cron") {
    unexpectedKeys(trigger, new Set([...baseKeys, "expression", "timezone"]), path, issues);
    const expression = stringAt(trigger, "expression", path, issues);
    if (expression) {
      try {
        parseCron(expression);
      } catch (error) {
        issue(
          issues,
          `${path}.expression`,
          "trigger.cron",
          error instanceof Error ? error.message : "must be a valid five-field cron expression",
        );
      }
    }
    const timezone = stringAt(trigger, "timezone", path, issues);
    if (timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
      } catch {
        issue(issues, `${path}.timezone`, "trigger.timezone", "must be a valid IANA timezone");
      }
    }
  } else if (kind === "webhook") {
    unexpectedKeys(
      trigger,
      new Set([...baseKeys, "adapter", "eventType", "webhookRef"]),
      path,
      issues,
    );
    enumAt(trigger, "adapter", ["http", "email"], path, issues);
    stringAt(trigger, "eventType", path, issues);
    stringAt(trigger, "webhookRef", path, issues);
  } else if (kind === "queue") {
    unexpectedKeys(trigger, new Set([...baseKeys, "queueRef", "eventType"]), path, issues);
    stringAt(trigger, "queueRef", path, issues);
    stringAt(trigger, "eventType", path, issues);
  } else if (kind === "alert") {
    unexpectedKeys(trigger, new Set([...baseKeys, "alertRuleId"]), path, issues);
    stringAt(trigger, "alertRuleId", path, issues);
  }
  return id;
}

function validateExitPredicates(value: unknown, path: string, issues: IssueCollector): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "type.array", "must be an array");
    return;
  }
  if (value.length === 0) {
    issue(
      issues,
      path,
      "worker.exit_predicate_required",
      "must contain at least one exit predicate",
    );
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const predicatePath = `${path}[${index}]`;
    const predicate = recordAt(entry, predicatePath, issues);
    if (!predicate) return;
    const id = stringAt(predicate, "id", predicatePath, issues);
    if (id && seen.has(id))
      issue(issues, `${predicatePath}.id`, "array.unique", `duplicates ${JSON.stringify(id)}`);
    if (id) seen.add(id);
    const kind = enumAt(
      predicate,
      "kind",
      ["objective_satisfied", "output_matches", "acceptance_checks_pass", "manual_completion"],
      predicatePath,
      issues,
    );
    stringAt(predicate, "description", predicatePath, issues);
    const expression = stringAt(predicate, "expression", predicatePath, issues, { optional: true });
    if (kind === "output_matches" && expression === undefined) {
      issue(
        issues,
        `${predicatePath}.expression`,
        "exit.expression_required",
        "is required for output_matches",
      );
    }
    if (kind !== "output_matches" && expression !== undefined) {
      issue(
        issues,
        `${predicatePath}.expression`,
        "object.unexpected_field",
        `is not valid for predicate kind ${kind}`,
      );
    }
  });
}

function validateNotificationRoutes(value: unknown, path: string, issues: IssueCollector): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "type.array", "must be an array");
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const routePath = `${path}[${index}]`;
    const route = recordAt(entry, routePath, issues);
    if (!route) return;
    const id = stringAt(route, "id", routePath, issues);
    if (id && seen.has(id))
      issue(issues, `${routePath}.id`, "array.unique", `duplicates ${JSON.stringify(id)}`);
    if (id) seen.add(id);
    enumAt(
      route,
      "kind",
      ["packetagent", "packetchat", "packetphone", "webhook", "email"],
      routePath,
      issues,
    );
    stringAt(route, "reference", routePath, issues);
    const events = stringArrayAt(route, "events", routePath, issues, {
      minLength: 1,
      unique: true,
    });
    events.forEach((event, eventIndex) => {
      if (event !== "attention" && event !== "terminal") {
        issue(
          issues,
          `${routePath}.events[${eventIndex}]`,
          "enum",
          "must be attention or terminal",
        );
      }
    });
  });
}

function validateVersionContent(value: unknown, path: string, issues: IssueCollector): void {
  const content = recordAt(value, path, issues);
  if (!content) return;
  stringAt(content, "objective", path, issues);
  stringAt(content, "instructions", path, issues, { minLength: 10 });
  validateInputSchema(content.inputSchema, `${path}.inputSchema`, issues);
  validateExecution(content.execution, `${path}.execution`, issues);

  const tools = arrayAt(content, "tools", path, issues);
  const capabilityIds = new Set<string>();
  if (tools) {
    tools.forEach((entry, index) => {
      const id = validateCapability(entry, `${path}.tools[${index}]`, issues);
      if (!id) return;
      if (capabilityIds.has(id)) {
        issue(
          issues,
          `${path}.tools[${index}].id`,
          "array.unique",
          `duplicates ${JSON.stringify(id)}`,
        );
      }
      capabilityIds.add(id);
    });
  }

  stringArrayAt(content, "credentialRefs", path, issues, { unique: true });

  const triggers = arrayAt(content, "triggers", path, issues);
  const triggerIds = new Set<string>();
  if (triggers) {
    if (triggers.length === 0) {
      issue(
        issues,
        `${path}.triggers`,
        "worker.trigger_required",
        "must contain at least one trigger",
      );
    }
    triggers.forEach((entry, index) => {
      const id = validateTrigger(entry, `${path}.triggers[${index}]`, issues);
      if (!id) return;
      if (triggerIds.has(id)) {
        issue(
          issues,
          `${path}.triggers[${index}].id`,
          "array.unique",
          `duplicates ${JSON.stringify(id)}`,
        );
      }
      triggerIds.add(id);
    });
  }

  validatePolicy(content.policy, capabilityIds, `${path}.policy`, issues);
  validateExitPredicates(content.exitPredicates, `${path}.exitPredicates`, issues);
  stringArrayAt(content, "acceptanceCommands", path, issues, { unique: true });
  validateNotificationRoutes(content.notificationRoutes, `${path}.notificationRoutes`, issues);
}

function validateJsonValue(value: unknown, path: string, issues: IssueCollector, depth = 0): void {
  if (depth > 32) {
    issue(issues, path, "json.depth", "must not exceed 32 nested levels");
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue(issues, path, "json.number", "must be finite");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateJsonValue(entry, `${path}[${index}]`, issues, depth + 1),
    );
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      if (entry === undefined) {
        issue(issues, `${path}.${key}`, "json.undefined", "must not be undefined");
      } else {
        validateJsonValue(entry, `${path}.${key}`, issues, depth + 1);
      }
    });
    return;
  }
  issue(issues, path, "json.value", "must be JSON-safe");
}

function validateStringCollection(value: unknown, path: string, issues: IssueCollector): void {
  if (!Array.isArray(value)) {
    issue(issues, path, "type.array", "must be an array");
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      issue(issues, `${path}[${index}]`, "type.non_empty_string", "must be a non-empty string");
    } else if (seen.has(entry)) {
      issue(issues, `${path}[${index}]`, "array.unique", `duplicates ${JSON.stringify(entry)}`);
    } else {
      seen.add(entry);
    }
  });
}

function validateBudgetShape(value: unknown, path: string, issues: IssueCollector): void {
  const budget = recordAt(value, path, issues);
  if (!budget) return;
  numberAt(budget, "elapsedMs", path, issues, { integer: true, minimum: 0 });
  numberAt(budget, "iterations", path, issues, { integer: true, minimum: 0 });
  numberAt(budget, "providerCostUsd", path, issues, { minimum: 0 });
  numberAt(budget, "consecutiveFailures", path, issues, { integer: true, minimum: 0 });
  numberAt(budget, "toolCalls", path, issues, { integer: true, minimum: 0 });
}

function validateTrace(value: unknown, path: string, issues: IssueCollector): void {
  if (value === undefined) return;
  const trace = recordAt(value, path, issues);
  if (!trace) return;
  const traceId = stringAt(trace, "traceId", path, issues);
  const spanId = stringAt(trace, "spanId", path, issues, { optional: true });
  stringAt(trace, "traceState", path, issues, { optional: true });
  if (traceId && !/^[a-f0-9]{32}$/i.test(traceId)) {
    issue(issues, `${path}.traceId`, "trace.trace_id", "must contain 32 hexadecimal characters");
  }
  if (spanId && !/^[a-f0-9]{16}$/i.test(spanId)) {
    issue(issues, `${path}.spanId`, "trace.span_id", "must contain 16 hexadecimal characters");
  }
}

export function canonicalWorkerJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot digest a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalWorkerJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalWorkerJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("cannot digest a non-JSON value");
}

export function computeWorkerVersionContentDigest(content: WorkerVersionContent): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(content)).digest("hex")}`;
}

function finish<T>(value: unknown, issues: IssueCollector): WorkerContractValidation<T> {
  return issues.length === 0 ? { ok: true, value: value as T, issues: [] } : { ok: false, issues };
}

export function validateWorkerDefinition(
  value: unknown,
): WorkerContractValidation<WorkerDefinition> {
  const issues: IssueCollector = [];
  const record = recordAt(value, "$", issues);
  if (!record) return finish(value, issues);
  schemaVersionAt(record, "$", issues);
  stringAt(record, "id", "$", issues);
  stringAt(record, "workspaceId", "$", issues);
  stringAt(record, "name", "$", issues);
  stringAt(record, "description", "$", issues);
  enumAt(record, "status", DEFINITION_STATUSES, "$", issues);
  stringAt(record, "currentVersionId", "$", issues, { optional: true });
  validateActor(record.createdBy, "$.createdBy", issues);
  timestampAt(record, "createdAt", "$", issues);
  timestampAt(record, "updatedAt", "$", issues);
  return finish(value, issues);
}

export function validateWorkerVersion(value: unknown): WorkerContractValidation<WorkerVersion> {
  const issues: IssueCollector = [];
  const record = recordAt(value, "$", issues);
  if (!record) return finish(value, issues);
  schemaVersionAt(record, "$", issues);
  stringAt(record, "id", "$", issues);
  stringAt(record, "workspaceId", "$", issues);
  stringAt(record, "workerDefinitionId", "$", issues);
  numberAt(record, "version", "$", issues, { integer: true, exclusiveMinimum: 0 });
  const status = enumAt(record, "status", VERSION_STATUSES, "$", issues);
  validateVersionContent(record.content, "$.content", issues);
  const contentDigest = stringAt(record, "contentDigest", "$", issues);
  if (contentDigest && isRecord(record.content)) {
    const contentIssueCount = issues.filter((entry) => entry.path.startsWith("$.content")).length;
    if (contentIssueCount === 0) {
      const expected = computeWorkerVersionContentDigest(
        record.content as unknown as WorkerVersionContent,
      );
      if (contentDigest !== expected) {
        issue(issues, "$.contentDigest", "version.digest_mismatch", `must equal ${expected}`);
      }
    }
  }
  validateProvenance(record.source, "$.source", issues);
  validateActor(record.createdBy, "$.createdBy", issues);
  timestampAt(record, "createdAt", "$", issues);
  const validatedAt = timestampAt(record, "validatedAt", "$", issues, { optional: true });
  const rejectedAt = timestampAt(record, "rejectedAt", "$", issues, { optional: true });
  const retiredAt = timestampAt(record, "retiredAt", "$", issues, { optional: true });
  if (status === "validated" && !validatedAt) {
    issue(
      issues,
      "$.validatedAt",
      "version.validated_at_required",
      "is required for validated versions",
    );
  }
  if (status === "rejected" && !rejectedAt) {
    issue(
      issues,
      "$.rejectedAt",
      "version.rejected_at_required",
      "is required for rejected versions",
    );
  }
  if (status === "retired" && !retiredAt) {
    issue(issues, "$.retiredAt", "version.retired_at_required", "is required for retired versions");
  }
  return finish(value, issues);
}

export function validateWorkerTrigger(value: unknown): WorkerContractValidation<WorkerTrigger> {
  const issues: IssueCollector = [];
  validateTrigger(value, "$", issues);
  return finish(value, issues);
}

export function validateWorkerPolicy(
  value: unknown,
  declaredCapabilities: readonly WorkerToolCapability[] = [],
): WorkerContractValidation<WorkerPolicy> {
  const issues: IssueCollector = [];
  validatePolicy(
    value,
    new Set(declaredCapabilities.map((capability) => capability.id)),
    "$",
    issues,
  );
  return finish(value, issues);
}

export function validateWorkerDeployment(
  value: unknown,
): WorkerContractValidation<WorkerDeployment> {
  const issues: IssueCollector = [];
  const record = recordAt(value, "$", issues);
  if (!record) return finish(value, issues);
  schemaVersionAt(record, "$", issues);
  stringAt(record, "id", "$", issues);
  stringAt(record, "workspaceId", "$", issues);
  stringAt(record, "workerDefinitionId", "$", issues);
  stringAt(record, "workerVersionId", "$", issues);
  const status = enumAt(record, "status", DEPLOYMENT_STATUSES, "$", issues);
  numberAt(record, "revision", "$", issues, { integer: true, exclusiveMinimum: 0 });
  stringAt(record, "statusReason", "$", issues, { optional: true });
  validateActor(record.createdBy, "$.createdBy", issues);
  timestampAt(record, "createdAt", "$", issues);
  timestampAt(record, "updatedAt", "$", issues);
  const statusTimestamps: Partial<Record<(typeof DEPLOYMENT_STATUSES)[number], string>> = {
    validated: "validatedAt",
    deployed: "deployedAt",
    active: "activatedAt",
    paused: "pausedAt",
    attention: "attentionAt",
    retired: "retiredAt",
    rejected: "rejectedAt",
    revoked: "revokedAt",
  };
  for (const key of Object.values(statusTimestamps))
    timestampAt(record, key, "$", issues, { optional: true });
  const requiredTimestamp = status ? statusTimestamps[status] : undefined;
  if (requiredTimestamp && record[requiredTimestamp] === undefined) {
    issue(
      issues,
      `$.${requiredTimestamp}`,
      "deployment.status_timestamp_required",
      `is required for ${status} deployments`,
    );
  }
  return finish(value, issues);
}

export function validateWorkerRun(value: unknown): WorkerContractValidation<WorkerRun> {
  const issues: IssueCollector = [];
  const record = recordAt(value, "$", issues);
  if (!record) return finish(value, issues);
  schemaVersionAt(record, "$", issues);
  stringAt(record, "id", "$", issues);
  stringAt(record, "workspaceId", "$", issues);
  stringAt(record, "workerDefinitionId", "$", issues);
  stringAt(record, "workerVersionId", "$", issues);
  stringAt(record, "workerDeploymentId", "$", issues);
  stringAt(record, "triggerId", "$", issues);
  enumAt(record, "triggerKind", ["manual", "cron", "webhook", "queue", "alert"], "$", issues);
  const status = enumAt(record, "status", RUN_STATUSES, "$", issues);
  numberAt(record, "attempt", "$", issues, { integer: true, exclusiveMinimum: 0 });
  numberAt(record, "revision", "$", issues, { integer: true, exclusiveMinimum: 0 });
  const runtimeFence = numberAt(record, "runtimeFence", "$", issues, {
    integer: true,
    minimum: 0,
  });
  if (record.input !== undefined) {
    if (!isRecord(record.input)) issue(issues, "$.input", "type.object", "must be a JSON object");
    else validateJsonValue(record.input, "$.input", issues);
  }
  stringAt(record, "inputReference", "$", issues, { optional: true });
  if (record.input !== undefined && record.inputReference !== undefined) {
    issue(
      issues,
      "$.inputReference",
      "run.ambiguous_input",
      "cannot be supplied together with inline input",
    );
  }
  if (record.output !== undefined) validateJsonValue(record.output, "$.output", issues);
  stringAt(record, "error", "$", issues, { optional: true });
  validateBudgetShape(record.budgetUsage, "$.budgetUsage", issues);
  const terminalReason = enumAt(
    record,
    "terminalReason",
    [
      "objective_satisfied",
      "exit_predicate_matched",
      "failure_limit",
      "unhandled_error",
      "elapsed_time",
      "iteration_limit",
      "provider_cost",
      "tool_call_limit",
      "operator_cancelled",
      "deployment_revoked",
      "lease_lost",
      "unsafe_replay",
    ],
    "$",
    record.terminalReason === undefined ? [] : issues,
  );
  stringAt(record, "latestCheckpointId", "$", issues, { optional: true });
  if (record.runtimeLease !== undefined) {
    const lease = recordAt(record.runtimeLease, "$.runtimeLease", issues);
    if (lease) {
      stringAt(lease, "ownerId", "$.runtimeLease", issues);
      const leaseFence = numberAt(lease, "fencingToken", "$.runtimeLease", issues, {
        integer: true,
        exclusiveMinimum: 0,
      });
      if (runtimeFence !== undefined && leaseFence !== undefined && leaseFence !== runtimeFence) {
        issue(
          issues,
          "$.runtimeLease.fencingToken",
          "run.lease_fence_mismatch",
          "must match the run runtimeFence",
        );
      }
      const acquiredAt = timestampAt(lease, "acquiredAt", "$.runtimeLease", issues);
      const renewedAt = timestampAt(lease, "renewedAt", "$.runtimeLease", issues);
      const expiresAt = timestampAt(lease, "expiresAt", "$.runtimeLease", issues);
      if (
        acquiredAt &&
        renewedAt &&
        expiresAt &&
        (Date.parse(renewedAt) < Date.parse(acquiredAt) ||
          Date.parse(expiresAt) <= Date.parse(renewedAt))
      ) {
        issue(
          issues,
          "$.runtimeLease",
          "run.invalid_lease_window",
          "must have acquiredAt <= renewedAt < expiresAt",
        );
      }
    }
  }
  validateTrace(record.trace, "$.trace", issues);
  timestampAt(record, "createdAt", "$", issues);
  timestampAt(record, "updatedAt", "$", issues);
  const startedAt = timestampAt(record, "startedAt", "$", issues, { optional: true });
  const completedAt = timestampAt(record, "completedAt", "$", issues, { optional: true });
  if (status && TERMINAL_RUN_STATUSES.has(status)) {
    if (!terminalReason)
      issue(
        issues,
        "$.terminalReason",
        "run.terminal_reason_required",
        "is required for terminal runs",
      );
    if (!completedAt)
      issue(issues, "$.completedAt", "run.completed_at_required", "is required for terminal runs");
    if (terminalReason && !TERMINAL_REASONS_BY_STATUS[status].includes(terminalReason)) {
      issue(
        issues,
        "$.terminalReason",
        "run.terminal_reason_mismatch",
        `is not valid for status ${status}`,
      );
    }
  } else if (status) {
    if (record.terminalReason !== undefined) {
      issue(
        issues,
        "$.terminalReason",
        "run.non_terminal_reason",
        "must be absent for non-terminal runs",
      );
    }
    if (record.completedAt !== undefined) {
      issue(
        issues,
        "$.completedAt",
        "run.non_terminal_completed_at",
        "must be absent for non-terminal runs",
      );
    }
  }
  if (status && status !== "queued" && !startedAt) {
    issue(issues, "$.startedAt", "run.started_at_required", `is required for ${status} runs`);
  }
  return finish(value, issues);
}

export function validateWorkerCheckpoint(
  value: unknown,
): WorkerContractValidation<WorkerCheckpoint> {
  const issues: IssueCollector = [];
  const record = recordAt(value, "$", issues);
  if (!record) return finish(value, issues);
  schemaVersionAt(record, "$", issues);
  stringAt(record, "id", "$", issues);
  stringAt(record, "workspaceId", "$", issues);
  stringAt(record, "workerRunId", "$", issues);
  stringAt(record, "workerVersionId", "$", issues);
  numberAt(record, "sequence", "$", issues, { integer: true, minimum: 0 });
  stringAt(record, "previousCheckpointId", "$", issues, { optional: true });
  const cursor = recordAt(record.cursor, "$.cursor", issues);
  if (cursor) {
    enumAt(
      cursor,
      "phase",
      ["plan", "act", "evaluate", "checkpoint", "decide", "attention"],
      "$.cursor",
      issues,
    );
    numberAt(cursor, "iteration", "$.cursor", issues, { integer: true, minimum: 0 });
    numberAt(cursor, "actionIndex", "$.cursor", issues, { integer: true, minimum: 0 });
  }
  if (!isRecord(record.workingMemory))
    issue(issues, "$.workingMemory", "type.object", "must be a JSON object");
  else validateJsonValue(record.workingMemory, "$.workingMemory", issues);
  for (const key of [
    "completedActionIds",
    "pendingApprovalIds",
    "artifactRefs",
    "effectReceiptIds",
  ]) {
    validateStringCollection(record[key], `$.${key}`, issues);
  }
  validateBudgetShape(record.remainingBudget, "$.remainingBudget", issues);
  validateTrace(record.trace, "$.trace", issues);
  timestampAt(record, "createdAt", "$", issues);
  const stateDigest = stringAt(record, "stateDigest", "$", issues);
  if (stateDigest && !/^sha256:[a-f0-9]{64}$/.test(stateDigest)) {
    issue(
      issues,
      "$.stateDigest",
      "checkpoint.digest_format",
      "must be a sha256 digest",
    );
  }
  return finish(value, issues);
}

function assertValidation<T>(
  recordName: string,
  result: WorkerContractValidation<T>,
): asserts result is { readonly ok: true; readonly value: T; readonly issues: readonly [] } {
  if (!result.ok) throw new WorkerContractValidationError(recordName, result.issues);
}

export function assertValidWorkerDefinition(value: unknown): asserts value is WorkerDefinition {
  assertValidation("WorkerDefinition", validateWorkerDefinition(value));
}

export function assertValidWorkerVersion(value: unknown): asserts value is WorkerVersion {
  assertValidation("WorkerVersion", validateWorkerVersion(value));
}

export function assertValidWorkerDeployment(value: unknown): asserts value is WorkerDeployment {
  assertValidation("WorkerDeployment", validateWorkerDeployment(value));
}

export function assertValidWorkerTrigger(value: unknown): asserts value is WorkerTrigger {
  assertValidation("WorkerTrigger", validateWorkerTrigger(value));
}

export function assertValidWorkerPolicy(
  value: unknown,
  declaredCapabilities: readonly WorkerToolCapability[] = [],
): asserts value is WorkerPolicy {
  assertValidation("WorkerPolicy", validateWorkerPolicy(value, declaredCapabilities));
}

export function assertValidWorkerRun(value: unknown): asserts value is WorkerRun {
  assertValidation("WorkerRun", validateWorkerRun(value));
}

export function assertValidWorkerCheckpoint(value: unknown): asserts value is WorkerCheckpoint {
  assertValidation("WorkerCheckpoint", validateWorkerCheckpoint(value));
}

export interface WorkerContractRecordSet {
  readonly definition: WorkerDefinition;
  readonly versions?: readonly WorkerVersion[];
  readonly deployments?: readonly WorkerDeployment[];
  readonly runs?: readonly WorkerRun[];
  readonly checkpoints?: readonly WorkerCheckpoint[];
}

export function validateWorkerRecordSet(
  value: WorkerContractRecordSet,
): readonly WorkerContractIssue[] {
  const issues: IssueCollector = [];
  const versions = new Map((value.versions ?? []).map((version) => [version.id, version]));
  const deployments = new Map(
    (value.deployments ?? []).map((deployment) => [deployment.id, deployment]),
  );
  const runs = new Map((value.runs ?? []).map((run) => [run.id, run]));

  for (const version of versions.values()) {
    if (version.workerDefinitionId !== value.definition.id) {
      issue(
        issues,
        `versions.${version.id}.workerDefinitionId`,
        "relationship.definition",
        "does not match definition.id",
      );
    }
    if (version.workspaceId !== value.definition.workspaceId) {
      issue(
        issues,
        `versions.${version.id}.workspaceId`,
        "relationship.workspace",
        "does not match definition.workspaceId",
      );
    }
  }
  for (const deployment of deployments.values()) {
    const version = versions.get(deployment.workerVersionId);
    if (!version) {
      issue(
        issues,
        `deployments.${deployment.id}.workerVersionId`,
        "relationship.version",
        "does not reference a supplied version",
      );
      continue;
    }
    const requiresValidatedVersion = [
      "validated",
      "deployed",
      "active",
      "paused",
      "attention",
    ].includes(deployment.status);
    if (requiresValidatedVersion && version.status !== "validated") {
      issue(
        issues,
        `deployments.${deployment.id}.workerVersionId`,
        "deployment.version_not_validated",
        "must reference a validated version",
      );
    }
    if (
      deployment.workerDefinitionId !== value.definition.id ||
      deployment.workspaceId !== value.definition.workspaceId
    ) {
      issue(
        issues,
        `deployments.${deployment.id}`,
        "relationship.definition",
        "does not match the supplied definition",
      );
    }
  }
  for (const run of runs.values()) {
    const deployment = deployments.get(run.workerDeploymentId);
    if (!deployment) {
      issue(
        issues,
        `runs.${run.id}.workerDeploymentId`,
        "relationship.deployment",
        "does not reference a supplied deployment",
      );
      continue;
    }
    if (run.workerVersionId !== deployment.workerVersionId) {
      issue(
        issues,
        `runs.${run.id}.workerVersionId`,
        "run.version_pin",
        "must match the deployment's immutable version",
      );
    }
  }
  for (const checkpoint of value.checkpoints ?? []) {
    const run = runs.get(checkpoint.workerRunId);
    if (!run) {
      issue(
        issues,
        `checkpoints.${checkpoint.id}.workerRunId`,
        "relationship.run",
        "does not reference a supplied run",
      );
      continue;
    }
    if (checkpoint.workerVersionId !== run.workerVersionId) {
      issue(
        issues,
        `checkpoints.${checkpoint.id}.workerVersionId`,
        "checkpoint.version_pin",
        "must match the run version",
      );
    }
  }
  return issues;
}

export function actorReference(value: WorkerActorReference): WorkerActorReference {
  assertValidActorReference(value);
  return value;
}

export function sourceProvenance(value: WorkerSourceProvenance): WorkerSourceProvenance {
  assertValidSourceProvenance(value);
  return value;
}

function assertValidActorReference(value: unknown): asserts value is WorkerActorReference {
  const issues: IssueCollector = [];
  validateActor(value, "$", issues);
  if (issues.length) throw new WorkerContractValidationError("WorkerActorReference", issues);
}

function assertValidSourceProvenance(value: unknown): asserts value is WorkerSourceProvenance {
  const issues: IssueCollector = [];
  validateProvenance(value, "$", issues);
  if (issues.length) throw new WorkerContractValidationError("WorkerSourceProvenance", issues);
}

export function toolCapability(value: WorkerToolCapability): WorkerToolCapability {
  const issues: IssueCollector = [];
  validateCapability(value, "$", issues);
  if (issues.length) throw new WorkerContractValidationError("WorkerToolCapability", issues);
  return value;
}

export function workerTrigger(value: WorkerTrigger): WorkerTrigger {
  assertValidWorkerTrigger(value);
  return value;
}
