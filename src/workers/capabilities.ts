import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  WORKER_COMPILED_POLICY_SCHEMA_VERSION,
  type WorkerCapabilityApproval,
  type WorkerCapabilityEffect,
  type WorkerCompiledCapability,
  type WorkerCompiledPolicy,
  type WorkerDeployment,
  type WorkerDeploymentCapabilityGrant,
  type WorkerToolCapability,
  type WorkerVersion,
} from "./types.js";

type WorkerCapabilityResourceKind =
  | "network"
  | "workspace"
  | "browser"
  | "github"
  | "slack"
  | "email"
  | "database"
  | "execution";

interface WorkerToolCapabilitySchema {
  readonly verbs: Readonly<Record<string, WorkerCapabilityEffect>>;
  readonly resourceKind: WorkerCapabilityResourceKind;
}

export interface WorkerCapabilityCompilationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class WorkerCapabilityCompilationError extends Error {
  constructor(readonly issues: readonly WorkerCapabilityCompilationIssue[]) {
    super(issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
    this.name = "WorkerCapabilityCompilationError";
  }
}

export interface WorkerCapabilityCompilationInput {
  readonly workerVersionContentDigest: string;
  readonly requestedCapabilities: readonly WorkerToolCapability[];
  readonly allowedCapabilityIds: readonly string[];
  readonly credentialRefs: readonly string[];
  readonly deploymentGrants?: readonly WorkerDeploymentCapabilityGrant[];
}

export interface WorkerCapabilityCompilationResult {
  readonly grants: readonly WorkerDeploymentCapabilityGrant[];
  readonly policy: WorkerCompiledPolicy;
}

export interface WorkerCapabilityOperationInput {
  readonly tool: string;
  readonly verb: string;
  readonly resources: readonly string[];
  readonly effect: WorkerCapabilityEffect;
}

export interface WorkerCapabilityOperation {
  readonly tool: string;
  readonly verb: string;
  readonly resources: readonly string[];
  readonly effect: WorkerCapabilityEffect;
}

/**
 * A capability with this sole resource never authorizes an operation directly.
 * It only lets an approval-required capability surface an exact operation to
 * the durable Worker attention flow.
 */
export const WORKER_APPROVAL_BOUND_RESOURCE = "packetagent:approval-bound" as const;

export function approvalBoundWorkerToolCapabilities(
  toolNames: readonly string[],
  idPrefix = "approval-bound",
): WorkerToolCapability[] {
  const capabilities: WorkerToolCapability[] = [];
  const seen = new Set<string>();
  for (const rawTool of toolNames) {
    const tool = rawTool.trim();
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    const schema = WORKER_TOOL_CAPABILITY_SCHEMAS[tool];
    if (!schema) {
      throw new WorkerCapabilityCompilationError([
        {
          path: "toolNames",
          code: "capability.unknown_tool",
          message: `contains unregistered Worker tool ${JSON.stringify(tool)}`,
        },
      ]);
    }
    const byEffect = new Map<WorkerCapabilityEffect, string[]>();
    for (const [verb, effect] of Object.entries(schema.verbs)) {
      const verbs = byEffect.get(effect) ?? [];
      verbs.push(verb);
      byEffect.set(effect, verbs);
    }
    for (const effect of ["read", "write", "execute"] as const) {
      const verbs = byEffect.get(effect);
      if (!verbs?.length) continue;
      capabilities.push({
        id: `${idPrefix}:${tool}:${effect}`,
        tool,
        verbs: verbs.sort(),
        resources: [WORKER_APPROVAL_BOUND_RESOURCE],
        effect,
        approval: "always",
      });
    }
  }
  return capabilities;
}

const READ = { READ: "read" } as const;
const LIST = { LIST: "read" } as const;
const CREATE = { CREATE: "write" } as const;

export const WORKER_TOOL_CAPABILITY_SCHEMAS: Readonly<Record<string, WorkerToolCapabilitySchema>> =
  {
    read_workflow_brief: { verbs: READ, resourceKind: "workspace" },
    list_requirements: { verbs: LIST, resourceKind: "workspace" },
    list_plan_items: { verbs: LIST, resourceKind: "workspace" },
    list_blockers: { verbs: LIST, resourceKind: "workspace" },
    list_agents: { verbs: LIST, resourceKind: "workspace" },
    list_recent_runs: { verbs: LIST, resourceKind: "workspace" },
    http_get: { verbs: { GET: "read" }, resourceKind: "network" },
    create_plan_item: { verbs: CREATE, resourceKind: "workspace" },
    update_plan_item_status: { verbs: { UPDATE: "write" }, resourceKind: "workspace" },
    create_blocker: { verbs: CREATE, resourceKind: "workspace" },
    log_note: { verbs: { APPEND: "write" }, resourceKind: "workspace" },
    run_command: { verbs: { EXECUTE: "execute" }, resourceKind: "execution" },
    browser_goto: { verbs: { NAVIGATE: "execute" }, resourceKind: "network" },
    browser_click: { verbs: { CLICK: "execute" }, resourceKind: "browser" },
    browser_fill: { verbs: { FILL: "execute" }, resourceKind: "browser" },
    browser_extract: { verbs: { EXTRACT: "read" }, resourceKind: "browser" },
    browser_screenshot: { verbs: { CAPTURE: "execute" }, resourceKind: "browser" },
    browser_close: { verbs: { CLOSE: "execute" }, resourceKind: "browser" },
    http_fetch: {
      verbs: {
        GET: "read",
        POST: "write",
        PUT: "write",
        PATCH: "write",
        DELETE: "write",
      },
      resourceKind: "network",
    },
    slack_post_webhook: { verbs: { POST: "write" }, resourceKind: "slack" },
    github_api: {
      verbs: {
        LIST_PRS: "read",
        GET_PR: "read",
        GET_COMMENTS: "read",
        CREATE_COMMENT: "write",
      },
      resourceKind: "github",
    },
    email_send: { verbs: { SEND: "write" }, resourceKind: "email" },
    sql_query: {
      verbs: {
        READ: "read",
        MUTATE: "write",
      },
      resourceKind: "database",
    },
    shell_for_agent: { verbs: { EXECUTE: "execute" }, resourceKind: "execution" },
  };

export function compileWorkerCapabilityPolicy(
  input: WorkerCapabilityCompilationInput,
): WorkerCapabilityCompilationResult {
  const issues: WorkerCapabilityCompilationIssue[] = [];
  if (!isDigest(input.workerVersionContentDigest)) {
    addIssue(
      issues,
      "workerVersionContentDigest",
      "capability.version_digest",
      "must be a sha256 WorkerVersion content digest",
    );
  }
  validateCredentialRefs(input.credentialRefs, issues);

  const requestedById = new Map<string, NormalizedRequestedCapability>();
  input.requestedCapabilities.forEach((capability, index) => {
    const normalized = normalizeRequestedCapability(capability, `tools[${index}]`, issues);
    if (!normalized) return;
    if (requestedById.has(normalized.id)) {
      addIssue(
        issues,
        `tools[${index}].id`,
        "capability.duplicate_id",
        `duplicates ${JSON.stringify(normalized.id)}`,
      );
      return;
    }
    requestedById.set(normalized.id, normalized);
  });

  const allowedIds = new Set<string>();
  input.allowedCapabilityIds.forEach((capabilityId, index) => {
    if (allowedIds.has(capabilityId)) {
      addIssue(
        issues,
        `allowedCapabilityIds[${index}]`,
        "capability.duplicate_allow",
        `duplicates ${JSON.stringify(capabilityId)}`,
      );
    }
    allowedIds.add(capabilityId);
    if (!requestedById.has(capabilityId)) {
      addIssue(
        issues,
        `allowedCapabilityIds[${index}]`,
        "capability.unknown_allow",
        `references undeclared capability ${JSON.stringify(capabilityId)}`,
      );
    }
  });

  const grants =
    input.deploymentGrants === undefined
      ? defaultGrants(requestedById, allowedIds)
      : normalizeDeploymentGrants(input.deploymentGrants, requestedById, allowedIds, issues);
  const capabilities = compileGrantTuples(grants, requestedById, issues);
  detectContradictoryOverlaps(capabilities, issues);
  if (issues.length > 0) throw new WorkerCapabilityCompilationError(issues);

  const sortedGrants = [...grants].sort((left, right) =>
    left.capabilityId.localeCompare(right.capabilityId),
  );
  const sortedCapabilities = [...capabilities].sort(compareCompiledCapabilities);
  const content = {
    schemaVersion: WORKER_COMPILED_POLICY_SCHEMA_VERSION,
    workerVersionContentDigest: input.workerVersionContentDigest,
    capabilities: sortedCapabilities,
  };
  return {
    grants: sortedGrants,
    policy: {
      ...content,
      policyDigest: digest(content),
    },
  };
}

export function assertWorkerDeploymentPolicyIntegrity(
  deployment: WorkerDeployment,
  version: WorkerVersion,
): void {
  if (!deployment.capabilityGrants && !deployment.compiledPolicy) return;
  if (!deployment.capabilityGrants || !deployment.compiledPolicy) {
    throw new WorkerCapabilityCompilationError([
      {
        path: "deployment.compiledPolicy",
        code: "capability.incomplete_compilation",
        message: "must be stored together with deployment capability grants",
      },
    ]);
  }
  const expected = compileWorkerCapabilityPolicy({
    workerVersionContentDigest: version.contentDigest,
    requestedCapabilities: version.content.tools,
    allowedCapabilityIds: version.content.policy.permissions.allowedCapabilityIds,
    credentialRefs: version.content.credentialRefs,
    deploymentGrants: deployment.capabilityGrants,
  });
  if (canonicalJson(expected.policy) !== canonicalJson(deployment.compiledPolicy)) {
    throw new WorkerCapabilityCompilationError([
      {
        path: "deployment.compiledPolicy",
        code: "capability.compiled_policy_mismatch",
        message: "does not match the pinned WorkerVersion and deployment grants",
      },
    ]);
  }
}

export function normalizeWorkerCapabilityOperation(
  input: WorkerCapabilityOperationInput,
): WorkerCapabilityOperation {
  const issues: WorkerCapabilityCompilationIssue[] = [];
  const tool = input.tool.trim();
  const schema = WORKER_TOOL_CAPABILITY_SCHEMAS[tool];
  if (!schema) {
    addIssue(issues, "tool", "capability.unknown_tool", "is not a registered Worker tool");
  }
  const verb = input.verb.trim().toUpperCase();
  const expectedEffect = schema?.verbs[verb];
  if (!expectedEffect) {
    addIssue(issues, "verb", "capability.unknown_verb", "is not supported by this tool");
  } else if (expectedEffect !== input.effect) {
    addIssue(
      issues,
      "effect",
      "capability.effect_mismatch",
      `must be ${JSON.stringify(expectedEffect)} for this tool and verb`,
    );
  }
  const resources = schema
    ? normalizeRuntimeResources(input.resources, schema.resourceKind, issues)
    : [];
  if (issues.length > 0) throw new WorkerCapabilityCompilationError(issues);
  return {
    tool,
    verb,
    resources,
    effect: input.effect,
  };
}

export function workerCompiledPolicyDigest(
  policy: Omit<WorkerCompiledPolicy, "policyDigest">,
): string {
  return digest(policy);
}

export function workerCapabilityResourceContains(upperBound: string, candidate: string): boolean {
  return resourceContains(upperBound, candidate);
}

interface NormalizedRequestedCapability {
  readonly id: string;
  readonly tool: string;
  readonly verbs: readonly string[];
  readonly resources: readonly string[];
  readonly effect: WorkerCapabilityEffect;
  readonly approval: WorkerCapabilityApproval;
}

function normalizeRequestedCapability(
  capability: WorkerToolCapability,
  pathPrefix: string,
  issues: WorkerCapabilityCompilationIssue[],
): NormalizedRequestedCapability | null {
  const id = capability.id?.trim();
  const tool = capability.tool?.trim();
  if (!id) {
    addIssue(issues, `${pathPrefix}.id`, "capability.id_required", "is required");
  }
  if (!tool) {
    addIssue(issues, `${pathPrefix}.tool`, "capability.tool_required", "is required");
  }
  if (!id || !tool) return null;
  const schema = WORKER_TOOL_CAPABILITY_SCHEMAS[tool];
  if (!schema) {
    addIssue(
      issues,
      `${pathPrefix}.tool`,
      "capability.unknown_tool",
      `is not a registered Worker tool`,
    );
    return null;
  }
  const verbs = normalizeVerbs(
    capability.verbs,
    schema,
    capability.effect,
    `${pathPrefix}.verbs`,
    issues,
  );
  const resources = normalizeResources(
    capability.resources,
    schema.resourceKind,
    `${pathPrefix}.resources`,
    issues,
    capability.approval,
  );
  if (capability.approval !== "never" && capability.approval !== "always") {
    addIssue(issues, `${pathPrefix}.approval`, "capability.approval", "must be never or always");
  }
  return {
    id,
    tool,
    verbs,
    resources,
    effect: capability.effect,
    approval: capability.approval,
  };
}

function normalizeVerbs(
  verbs: readonly string[],
  schema: WorkerToolCapabilitySchema,
  effect: WorkerCapabilityEffect,
  pathPrefix: string,
  issues: WorkerCapabilityCompilationIssue[],
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  verbs.forEach((value, index) => {
    const verb = value.trim().toUpperCase();
    const expectedEffect = schema.verbs[verb];
    if (!expectedEffect) {
      addIssue(
        issues,
        `${pathPrefix}[${index}]`,
        "capability.unknown_verb",
        `is not supported by this tool`,
      );
      return;
    }
    if (expectedEffect !== effect) {
      addIssue(
        issues,
        `${pathPrefix}[${index}]`,
        "capability.effect_mismatch",
        `requires effect ${JSON.stringify(expectedEffect)}, not ${JSON.stringify(effect)}`,
      );
      return;
    }
    if (seen.has(verb)) {
      addIssue(
        issues,
        `${pathPrefix}[${index}]`,
        "capability.duplicate_verb",
        `duplicates normalized verb ${JSON.stringify(verb)}`,
      );
      return;
    }
    seen.add(verb);
    normalized.push(verb);
  });
  if (normalized.length === 0) {
    addIssue(issues, pathPrefix, "capability.verb_required", "must contain a supported verb");
  }
  return normalized.sort();
}

function normalizeResources(
  resources: readonly string[],
  kind: WorkerCapabilityResourceKind,
  pathPrefix: string,
  issues: WorkerCapabilityCompilationIssue[],
  approval?: WorkerCapabilityApproval,
): string[] {
  if (resources.length === 1 && resources[0]?.trim() === WORKER_APPROVAL_BOUND_RESOURCE) {
    if (approval !== "always") {
      addIssue(
        issues,
        pathPrefix,
        "capability.approval_bound_requires_approval",
        "may use the approval-bound resource only when approval is always",
      );
      return [];
    }
    return [WORKER_APPROVAL_BOUND_RESOURCE];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  resources.forEach((value, index) => {
    const resource = normalizeResource(value, kind, `${pathPrefix}[${index}]`, issues);
    if (!resource) return;
    if (seen.has(resource)) {
      addIssue(
        issues,
        `${pathPrefix}[${index}]`,
        "capability.duplicate_resource",
        `duplicates normalized resource ${JSON.stringify(resource)}`,
      );
      return;
    }
    seen.add(resource);
    normalized.push(resource);
  });
  if (normalized.length === 0) {
    addIssue(issues, pathPrefix, "capability.resource_required", "must contain a safe resource");
  }
  return normalized.sort();
}

function normalizeRuntimeResources(
  resources: readonly string[],
  kind: WorkerCapabilityResourceKind,
  issues: WorkerCapabilityCompilationIssue[],
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  resources.forEach((value, index) => {
    if (typeof value !== "string" || value.includes("*")) {
      addIssue(
        issues,
        `resources[${index}]`,
        "capability.runtime_resource",
        "must identify one concrete resource",
      );
      return;
    }
    const candidate =
      kind === "network"
        ? normalizeRuntimeHttpResource(value, `resources[${index}]`, issues)
        : normalizeResource(value, kind, `resources[${index}]`, issues);
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    normalized.push(candidate);
  });
  if (normalized.length === 0) {
    addIssue(issues, "resources", "capability.runtime_resource", "must identify a resource");
  }
  return normalized.sort();
}

function normalizeRuntimeHttpResource(
  resource: string,
  issuePath: string,
  issues: WorkerCapabilityCompilationIssue[],
): string | null {
  let url: URL;
  try {
    url = new URL(resource.trim());
  } catch {
    addIssue(issues, issuePath, "capability.network_url", "must be an absolute HTTP(S) URL");
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    addIssue(issues, issuePath, "capability.network_scheme", "must use the http or https scheme");
    return null;
  }
  if (url.username || url.password) {
    addIssue(
      issues,
      issuePath,
      "capability.network_ambiguous",
      "must not contain embedded credentials",
    );
    return null;
  }
  url.search = "";
  url.hash = "";
  return normalizeHttpResource(url.toString(), issuePath, issues);
}

function normalizeResource(
  value: string,
  kind: WorkerCapabilityResourceKind,
  issuePath: string,
  issues: WorkerCapabilityCompilationIssue[],
): string | null {
  const resource = value.trim();
  if (!resource || resource === "*") {
    addIssue(issues, issuePath, "capability.ambiguous_wildcard", "must not grant every resource");
    return null;
  }
  if (hasAmbiguousWildcard(resource)) {
    addIssue(
      issues,
      issuePath,
      "capability.ambiguous_wildcard",
      "may use only one terminal /* wildcard",
    );
    return null;
  }
  if (/^(?:\.\.?)(?:[\\/]|$)/.test(resource)) {
    addIssue(
      issues,
      issuePath,
      "capability.relative_filesystem",
      "must not use a relative filesystem path or traversal",
    );
    return null;
  }
  if (kind === "network") return normalizeHttpResource(resource, issuePath, issues);
  if (kind === "execution") return normalizeExecutionResource(resource, issuePath, issues);
  const schemes: Record<Exclude<WorkerCapabilityResourceKind, "network" | "execution">, string> = {
    workspace: "workspace",
    browser: "browser",
    github: "github",
    slack: "slack",
    email: "mailto",
    database: "database",
  };
  return normalizeOpaqueResource(resource, schemes[kind], issuePath, issues);
}

function normalizeHttpResource(
  resource: string,
  issuePath: string,
  issues: WorkerCapabilityCompilationIssue[],
): string | null {
  const wildcard = resource.endsWith("/*");
  const candidate = wildcard ? resource.slice(0, -1) : resource;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    addIssue(issues, issuePath, "capability.network_url", "must be an absolute HTTP(S) URL");
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    addIssue(issues, issuePath, "capability.network_scheme", "must use the http or https scheme");
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    addIssue(
      issues,
      issuePath,
      "capability.network_ambiguous",
      "must not contain credentials, query parameters, or fragments",
    );
    return null;
  }
  if (url.hostname.includes("*")) {
    addIssue(issues, issuePath, "capability.ambiguous_wildcard", "must name an exact network host");
    return null;
  }
  return `${url.toString()}${wildcard ? "*" : ""}`;
}

function normalizeExecutionResource(
  resource: string,
  issuePath: string,
  issues: WorkerCapabilityCompilationIssue[],
): string | null {
  if (resource.startsWith("command:")) {
    return normalizeOpaqueResource(resource, "command", issuePath, issues);
  }
  const wildcard = resource.endsWith("/*");
  const candidate = wildcard ? resource.slice(0, -2) : resource;
  let absolutePath: string;
  try {
    absolutePath = candidate.startsWith("file:") ? fileURLToPath(candidate) : candidate;
  } catch {
    addIssue(issues, issuePath, "capability.filesystem_url", "must be a valid file URL");
    return null;
  }
  if (!path.isAbsolute(absolutePath) || absolutePath.split(/[\\/]+/).includes("..")) {
    addIssue(
      issues,
      issuePath,
      "capability.relative_filesystem",
      "must be an absolute filesystem path without traversal",
    );
    return null;
  }
  const normalized = pathToFileURL(path.normalize(absolutePath)).toString();
  return wildcard ? `${normalized.replace(/\/$/, "")}/*` : normalized;
}

function normalizeOpaqueResource(
  resource: string,
  requiredScheme: string,
  issuePath: string,
  issues: WorkerCapabilityCompilationIssue[],
): string | null {
  const prefix = `${requiredScheme}:`;
  if (!resource.toLowerCase().startsWith(prefix) || resource.length === prefix.length) {
    addIssue(
      issues,
      issuePath,
      "capability.resource_scheme",
      `must use a ${requiredScheme}: resource reference`,
    );
    return null;
  }
  const payload = resource.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:+-]*(?:\/\*)?$/.test(payload) || payload.includes("..")) {
    addIssue(
      issues,
      issuePath,
      "capability.resource_reference",
      "must be an opaque reference without traversal or embedded secret syntax",
    );
    return null;
  }
  return `${requiredScheme}:${payload}`;
}

function normalizeDeploymentGrants(
  grants: readonly WorkerDeploymentCapabilityGrant[],
  requestedById: ReadonlyMap<string, NormalizedRequestedCapability>,
  allowedIds: ReadonlySet<string>,
  issues: WorkerCapabilityCompilationIssue[],
): WorkerDeploymentCapabilityGrant[] {
  const normalized: WorkerDeploymentCapabilityGrant[] = [];
  const seen = new Set<string>();
  grants.forEach((grant, index) => {
    const pathPrefix = `deploymentGrants[${index}]`;
    const capabilityId = grant.capabilityId?.trim();
    if (!capabilityId || seen.has(capabilityId)) {
      addIssue(
        issues,
        `${pathPrefix}.capabilityId`,
        "capability.duplicate_grant",
        capabilityId ? `duplicates ${JSON.stringify(capabilityId)}` : "is required",
      );
      return;
    }
    seen.add(capabilityId);
    const requested = requestedById.get(capabilityId);
    if (!requested || !allowedIds.has(capabilityId)) {
      addIssue(
        issues,
        `${pathPrefix}.capabilityId`,
        "capability.grant_not_requested",
        "must reference an allowed requested capability",
      );
      return;
    }
    const schema = WORKER_TOOL_CAPABILITY_SCHEMAS[requested.tool];
    const verbs = normalizeVerbs(
      grant.verbs,
      schema,
      requested.effect,
      `${pathPrefix}.verbs`,
      issues,
    );
    const resources = normalizeResources(
      grant.resources,
      schema.resourceKind,
      `${pathPrefix}.resources`,
      issues,
      grant.approval,
    );
    for (const verb of verbs) {
      if (!requested.verbs.includes(verb)) {
        addIssue(
          issues,
          `${pathPrefix}.verbs`,
          "capability.grant_broadens_verb",
          `adds verb ${JSON.stringify(verb)} outside the version request`,
        );
      }
    }
    for (const resource of resources) {
      if (!requested.resources.some((upperBound) => resourceContains(upperBound, resource))) {
        addIssue(
          issues,
          `${pathPrefix}.resources`,
          "capability.grant_broadens_resource",
          `adds resource ${JSON.stringify(resource)} outside the version request`,
        );
      }
    }
    if (requested.approval === "always" && grant.approval !== "always") {
      addIssue(
        issues,
        `${pathPrefix}.approval`,
        "capability.grant_relaxes_approval",
        "cannot remove the version's approval requirement",
      );
    }
    if (grant.approval !== "never" && grant.approval !== "always") {
      addIssue(issues, `${pathPrefix}.approval`, "capability.approval", "must be never or always");
    }
    normalized.push({
      capabilityId,
      verbs,
      resources,
      approval: grant.approval,
    });
  });
  return normalized;
}

function defaultGrants(
  requestedById: ReadonlyMap<string, NormalizedRequestedCapability>,
  allowedIds: ReadonlySet<string>,
): WorkerDeploymentCapabilityGrant[] {
  return [...allowedIds]
    .map((capabilityId) => requestedById.get(capabilityId))
    .filter((capability): capability is NormalizedRequestedCapability => Boolean(capability))
    .map((capability) => ({
      capabilityId: capability.id,
      verbs: [...capability.verbs],
      resources: [...capability.resources],
      approval: capability.approval,
    }));
}

function compileGrantTuples(
  grants: readonly WorkerDeploymentCapabilityGrant[],
  requestedById: ReadonlyMap<string, NormalizedRequestedCapability>,
  issues: WorkerCapabilityCompilationIssue[],
): WorkerCompiledCapability[] {
  const result: WorkerCompiledCapability[] = [];
  for (const grant of grants) {
    const requested = requestedById.get(grant.capabilityId);
    if (!requested) continue;
    for (const verb of grant.verbs) {
      for (const resource of grant.resources) {
        result.push({
          capabilityId: grant.capabilityId,
          tool: requested.tool,
          verb,
          resource,
          effect: requested.effect,
          approval: grant.approval,
        });
      }
    }
  }
  if (result.length > 10_000) {
    addIssue(
      issues,
      "deploymentGrants",
      "capability.expansion_limit",
      "expands to more than 10,000 policy tuples",
    );
  }
  return result;
}

function detectContradictoryOverlaps(
  capabilities: readonly WorkerCompiledCapability[],
  issues: WorkerCapabilityCompilationIssue[],
): void {
  for (let leftIndex = 0; leftIndex < capabilities.length; leftIndex += 1) {
    const left = capabilities[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < capabilities.length; rightIndex += 1) {
      const right = capabilities[rightIndex];
      if (
        left.tool !== right.tool ||
        left.verb !== right.verb ||
        !resourcesOverlap(left.resource, right.resource) ||
        (left.effect === right.effect && left.approval === right.approval)
      ) {
        continue;
      }
      addIssue(
        issues,
        "deploymentGrants",
        "capability.contradictory_overlap",
        `contains overlapping ${left.tool}/${left.verb} grants with different effect or approval`,
      );
      return;
    }
  }
}

function validateCredentialRefs(
  credentialRefs: readonly string[],
  issues: WorkerCapabilityCompilationIssue[],
): void {
  const seen = new Set<string>();
  credentialRefs.forEach((value, index) => {
    const reference = value.trim();
    if (!/^vault:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(reference)) {
      addIssue(
        issues,
        `credentialRefs[${index}]`,
        "capability.credential_reference",
        "must be an opaque vault: reference, never a credential value",
      );
    } else if (seen.has(reference)) {
      addIssue(
        issues,
        `credentialRefs[${index}]`,
        "capability.duplicate_credential_reference",
        `duplicates ${JSON.stringify(reference)}`,
      );
    }
    seen.add(reference);
  });
}

function hasAmbiguousWildcard(resource: string): boolean {
  const stars = [...resource].filter((character) => character === "*").length;
  return stars > 0 && (stars !== 1 || !resource.endsWith("/*"));
}

function resourceContains(upperBound: string, candidate: string): boolean {
  if (upperBound === candidate) return true;
  if (!upperBound.endsWith("*")) return false;
  const prefix = upperBound.slice(0, -1);
  return candidate.startsWith(prefix);
}

function resourcesOverlap(left: string, right: string): boolean {
  return resourceContains(left, right) || resourceContains(right, left);
}

function compareCompiledCapabilities(
  left: WorkerCompiledCapability,
  right: WorkerCompiledCapability,
): number {
  return (
    [
      left.tool.localeCompare(right.tool),
      left.verb.localeCompare(right.verb),
      left.resource.localeCompare(right.resource),
      left.effect.localeCompare(right.effect),
      left.approval.localeCompare(right.approval),
      left.capabilityId.localeCompare(right.capabilityId),
    ].find((value) => value !== 0) ?? 0
  );
}

function addIssue(
  issues: WorkerCapabilityCompilationIssue[],
  issuePath: string,
  code: string,
  message: string,
): void {
  issues.push({ path: issuePath, code, message });
}

function isDigest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot digest a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("cannot digest a non-JSON value");
}
