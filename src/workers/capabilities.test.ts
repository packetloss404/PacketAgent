import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkerCapabilityPolicy, WorkerCapabilityCompilationError } from "./capabilities.js";
import type { WorkerDeploymentCapabilityGrant, WorkerToolCapability } from "./types.js";
import { makeWorkerVersionContent } from "./__tests__/fixtures.js";
import { computeWorkerVersionContentDigest } from "./validation.js";

test("capability compiler emits normalized deterministic tuples tied to the version digest", () => {
  const content = makeWorkerVersionContent({
    tools: [
      capability({
        verbs: ["get"],
        resources: ["https://RELEASES.example.test:443/api/*"],
      }),
    ],
  });
  const digest = computeWorkerVersionContentDigest(content);

  const compiled = compileWorkerCapabilityPolicy({
    workerVersionContentDigest: digest,
    requestedCapabilities: content.tools,
    allowedCapabilityIds: ["release-read"],
    credentialRefs: content.credentialRefs,
  });

  assert.equal(compiled.policy.workerVersionContentDigest, digest);
  assert.match(compiled.policy.policyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(compiled.grants, [
    {
      capabilityId: "release-read",
      verbs: ["GET"],
      resources: ["https://releases.example.test/api/*"],
      approval: "never",
    },
  ]);
  assert.deepEqual(compiled.policy.capabilities, [
    {
      capabilityId: "release-read",
      tool: "http_fetch",
      verb: "GET",
      resource: "https://releases.example.test/api/*",
      effect: "read",
      approval: "never",
    },
  ]);
});

test("deployment grants can narrow resources and tighten approval but never broaden them", () => {
  const content = makeWorkerVersionContent({
    tools: [
      capability({
        resources: ["https://releases.example.test/api/*"],
      }),
    ],
  });
  const narrowed: WorkerDeploymentCapabilityGrant[] = [
    {
      capabilityId: "release-read",
      verbs: ["GET"],
      resources: ["https://releases.example.test/api/releases"],
      approval: "always",
    },
  ];

  const compiled = compile(content, narrowed);
  assert.equal(compiled.policy.capabilities[0].approval, "always");
  assert.equal(
    compiled.policy.capabilities[0].resource,
    "https://releases.example.test/api/releases",
  );

  assertCompilationIssue(
    () =>
      compile(content, [
        {
          ...narrowed[0],
          resources: ["https://releases.example.test/admin"],
        },
      ]),
    "capability.grant_broadens_resource",
  );

  const approvalRequired = makeWorkerVersionContent({
    tools: [capability({ approval: "always" })],
  });
  assertCompilationIssue(
    () =>
      compile(approvalRequired, [
        {
          capabilityId: "release-read",
          verbs: ["GET"],
          resources: ["https://releases.example.test/*"],
          approval: "never",
        },
      ]),
    "capability.grant_relaxes_approval",
  );
});

test("compiler rejects unknown verbs, broad wildcards, unsafe schemes, path escapes, and raw credentials", () => {
  const cases: Array<{
    readonly content: ReturnType<typeof makeWorkerVersionContent>;
    readonly code: string;
  }> = [
    {
      content: makeWorkerVersionContent({
        tools: [capability({ verbs: ["TRACE"] })],
      }),
      code: "capability.unknown_verb",
    },
    {
      content: makeWorkerVersionContent({
        tools: [capability({ resources: ["*"] })],
      }),
      code: "capability.ambiguous_wildcard",
    },
    {
      content: makeWorkerVersionContent({
        tools: [capability({ resources: ["ftp://releases.example.test/*"] })],
      }),
      code: "capability.network_scheme",
    },
    {
      content: makeWorkerVersionContent({
        tools: [
          capability({
            tool: "shell_for_agent",
            verbs: ["EXECUTE"],
            resources: ["../outside"],
            effect: "execute",
          }),
        ],
      }),
      code: "capability.relative_filesystem",
    },
    {
      content: makeWorkerVersionContent({
        credentialRefs: ["sk-secret-value"],
      }),
      code: "capability.credential_reference",
    },
  ];

  for (const entry of cases) {
    assertCompilationIssue(() => compile(entry.content), entry.code);
  }
});

test("compiler rejects overlapping grants with contradictory approval requirements", () => {
  const first = capability({
    id: "release-read-automatic",
    resources: ["https://releases.example.test/api/*"],
    approval: "never",
  });
  const second = capability({
    id: "release-read-approved",
    resources: ["https://releases.example.test/api/releases/*"],
    approval: "always",
  });
  const content = makeWorkerVersionContent({
    tools: [first, second],
    policy: {
      ...makeWorkerVersionContent().policy,
      permissions: {
        default: "deny",
        allowedCapabilityIds: [first.id, second.id],
      },
    },
  });

  assertCompilationIssue(
    () =>
      compileWorkerCapabilityPolicy({
        workerVersionContentDigest: computeWorkerVersionContentDigest(content),
        requestedCapabilities: content.tools,
        allowedCapabilityIds: content.policy.permissions.allowedCapabilityIds,
        credentialRefs: content.credentialRefs,
      }),
    "capability.contradictory_overlap",
  );
});

function compile(
  content: ReturnType<typeof makeWorkerVersionContent>,
  deploymentGrants?: readonly WorkerDeploymentCapabilityGrant[],
) {
  return compileWorkerCapabilityPolicy({
    workerVersionContentDigest: computeWorkerVersionContentDigest(content),
    requestedCapabilities: content.tools,
    allowedCapabilityIds: content.policy.permissions.allowedCapabilityIds,
    credentialRefs: content.credentialRefs,
    ...(deploymentGrants ? { deploymentGrants } : {}),
  });
}

function capability(overrides: Partial<WorkerToolCapability> = {}): WorkerToolCapability {
  return {
    id: "release-read",
    tool: "http_fetch",
    verbs: ["GET"],
    resources: ["https://releases.example.test/*"],
    effect: "read",
    approval: "never",
    ...overrides,
  };
}

function assertCompilationIssue(run: () => unknown, code: string): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof WorkerCapabilityCompilationError &&
      error.issues.some((issue) => issue.code === code),
  );
}
