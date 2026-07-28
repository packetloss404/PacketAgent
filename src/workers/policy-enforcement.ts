import { createHash } from "node:crypto";
import type {
  ToolAuthorizationDescriptor,
  ToolPolicyDecision,
  WorkerToolContext,
} from "../tools/types.js";
import {
  normalizeWorkerCapabilityOperation,
  workerCapabilityResourceContains,
  workerCompiledPolicyDigest,
  type WorkerCapabilityOperation,
} from "./capabilities.js";
import { WORKER_COMPILED_POLICY_SCHEMA_VERSION, type WorkerCapabilityEffect } from "./types.js";

export interface WorkerToolPolicyEvaluation {
  readonly decision: ToolPolicyDecision;
  readonly operation?: WorkerCapabilityOperation;
}

export function evaluateWorkerToolPolicy(input: {
  readonly tool: string;
  readonly descriptor?: ToolAuthorizationDescriptor;
  readonly worker: WorkerToolContext;
  readonly fallbackEffect: WorkerCapabilityEffect;
}): WorkerToolPolicyEvaluation {
  const fallback = decisionBase({
    tool: input.tool,
    verb: input.descriptor?.verb ?? "UNKNOWN",
    effect: input.descriptor?.effect ?? input.fallbackEffect,
    resources: input.descriptor?.resources ?? [],
  });
  if (!input.descriptor) {
    return {
      decision: {
        ...fallback,
        allowed: false,
        code: "missing_authorization_descriptor",
      },
    };
  }

  let operation: WorkerCapabilityOperation;
  try {
    operation = normalizeWorkerCapabilityOperation({
      tool: input.tool,
      verb: input.descriptor.verb,
      resources: input.descriptor.resources,
      effect: input.descriptor.effect,
    });
  } catch {
    return {
      decision: {
        ...fallback,
        allowed: false,
        code: "invalid_operation",
      },
    };
  }

  const base = decisionBase(operation);
  const policy = input.worker.deployment.compiledPolicy;
  if (!policy) {
    return {
      operation,
      decision: {
        ...base,
        allowed: false,
        code: "missing_compiled_policy",
      },
    };
  }
  if (
    policy.schemaVersion !== WORKER_COMPILED_POLICY_SCHEMA_VERSION ||
    policy.workerVersionContentDigest !== input.worker.version.contentDigest
  ) {
    return {
      operation,
      decision: {
        ...base,
        allowed: false,
        code: "stale_policy",
        policyDigest: policy.policyDigest,
      },
    };
  }
  const { policyDigest, ...policyContent } = policy;
  if (workerCompiledPolicyDigest(policyContent) !== policyDigest) {
    return {
      operation,
      decision: {
        ...base,
        allowed: false,
        code: "tampered_policy",
        policyDigest,
      },
    };
  }

  const byCapability = new Map<
    string,
    {
      readonly approval: "never" | "always";
      readonly resources: string[];
    }
  >();
  for (const capability of policy.capabilities) {
    if (
      capability.tool !== operation.tool ||
      capability.verb !== operation.verb ||
      capability.effect !== operation.effect ||
      (input.worker.capability && capability.capabilityId !== input.worker.capability.id)
    ) {
      continue;
    }
    const current = byCapability.get(capability.capabilityId);
    if (current) {
      current.resources.push(capability.resource);
    } else {
      byCapability.set(capability.capabilityId, {
        approval: capability.approval,
        resources: [capability.resource],
      });
    }
  }

  const matches = [...byCapability.entries()]
    .filter(([, candidate]) =>
      operation.resources.every((resource) =>
        candidate.resources.some((upperBound) =>
          workerCapabilityResourceContains(upperBound, resource),
        ),
      ),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const allowed = matches.find(([, candidate]) => candidate.approval === "never");
  if (allowed) {
    return {
      operation,
      decision: {
        ...base,
        allowed: true,
        code: "allowed",
        policyDigest,
        capabilityId: allowed[0],
      },
    };
  }
  const approvalRequired = matches.find(([, candidate]) => candidate.approval === "always");
  const approval = input.worker.approval;
  if (
    approvalRequired &&
    approval &&
    approval.capabilityId === approvalRequired[0] &&
    approval.operationDigest === base.operationDigest &&
    approval.policyDigest === policyDigest
  ) {
    return {
      operation,
      decision: {
        ...base,
        allowed: true,
        code: "allowed",
        policyDigest,
        capabilityId: approvalRequired[0],
        approvalGrantId: approval.grantId,
        attentionRequestId: approval.attentionRequestId,
      },
    };
  }
  return {
    operation,
    decision: {
      ...base,
      allowed: false,
      code: approvalRequired ? "approval_required" : "capability_not_granted",
      policyDigest,
      ...(approvalRequired ? { capabilityId: approvalRequired[0] } : {}),
    },
  };
}

function decisionBase(input: {
  readonly tool: string;
  readonly verb: string;
  readonly effect: WorkerCapabilityEffect;
  readonly resources: readonly string[];
}): Omit<ToolPolicyDecision, "allowed" | "code"> {
  const normalized = {
    tool: input.tool,
    verb: input.verb.trim().toUpperCase(),
    effect: input.effect,
    resources: [...input.resources].sort(),
  };
  return {
    tool: normalized.tool,
    verb: normalized.verb,
    effect: normalized.effect,
    operationDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex")}`,
    resourceCount: normalized.resources.length,
    resourceSchemes: [
      ...new Set(
        normalized.resources.map((resource) => {
          const separator = resource.indexOf(":");
          return separator > 0 ? resource.slice(0, separator).toLowerCase() : "unknown";
        }),
      ),
    ].sort(),
  };
}
