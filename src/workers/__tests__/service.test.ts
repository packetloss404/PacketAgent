import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../../packetagent-store.js";
import { WorkerLifecycleError } from "../errors.js";
import { createWorkerRepository } from "../repository.js";
import { createWorkerLifecycleService, type WorkerCommandContext } from "../service.js";
import type { WorkerSourceProvenance, WorkerVersionContent } from "../types.js";
import { makeWorkerVersionContent } from "./fixtures.js";

const ACTOR = { type: "user", id: "user_alpha", displayName: "Alpha" } as const;
const SOURCE: WorkerSourceProvenance = {
  product: "PacketAgent",
  kind: "native",
};

test("Worker lifecycle executes draft through retirement with optimistic revisions", async () => {
  const harness = createHarness();
  const created = await harness.service.createDefinition({
    ...command("create"),
    definitionId: "worker-alpha",
    versionId: "version-alpha-1",
    name: "Release watcher",
    description: "Checks release readiness within explicit bounds.",
    content: content(),
    source: SOURCE,
  });
  assert.equal(created.definition?.status, "draft");
  assert.equal(created.version?.version, 1);

  const revisedContent = content({
    objective: "Verify the release and report a bounded readiness decision.",
  });
  const updated = await harness.service.updateDraftVersion({
    ...command("update"),
    workerVersionId: "version-alpha-1",
    expectedContentDigest: created.version!.contentDigest,
    content: revisedContent,
  });
  assert.notEqual(updated.version?.contentDigest, created.version?.contentDigest);

  const validated = await harness.service.validateVersion({
    ...command("validate-version"),
    workerVersionId: "version-alpha-1",
    expectedContentDigest: updated.version!.contentDigest,
  });
  assert.equal(validated.version?.status, "validated");

  const draftedDeployment = await harness.service.createDeployment({
    ...command("create-deployment"),
    deploymentId: "deployment-alpha-1",
    workerVersionId: "version-alpha-1",
  });
  assert.equal(draftedDeployment.deployment?.revision, 1);
  assert.equal(
    draftedDeployment.deployment?.compiledPolicy?.workerVersionContentDigest,
    validated.version?.contentDigest,
  );
  assert.deepEqual(draftedDeployment.deployment?.capabilityGrants, [
    {
      capabilityId: "release-read",
      verbs: ["GET"],
      resources: ["https://releases.example.test/*"],
      approval: "never",
    },
  ]);

  const validatedDeployment = await harness.service.validateDeployment({
    ...command("validate-deployment"),
    workerDeploymentId: "deployment-alpha-1",
    expectedRevision: 1,
  });
  const deployed = await harness.service.deploy({
    ...command("deploy"),
    workerDeploymentId: "deployment-alpha-1",
    expectedRevision: validatedDeployment.deployment!.revision,
  });
  const active = await harness.service.activate({
    ...command("activate"),
    workerDeploymentId: "deployment-alpha-1",
    expectedRevision: deployed.deployment!.revision,
  });
  const paused = await harness.service.pause({
    ...command("pause"),
    workerDeploymentId: "deployment-alpha-1",
    expectedRevision: active.deployment!.revision,
  });
  const resumed = await harness.service.resume({
    ...command("resume"),
    workerDeploymentId: "deployment-alpha-1",
    expectedRevision: paused.deployment!.revision,
  });
  const retired = await harness.service.retireDeployment({
    ...command("retire-deployment"),
    workerDeploymentId: "deployment-alpha-1",
    expectedRevision: resumed.deployment!.revision,
  });

  assert.equal(retired.deployment?.status, "retired");
  assert.equal(retired.deployment?.revision, 7);
  assert.equal(retired.definition?.status, "active");
  assert.equal(retired.definition?.currentVersionId, "version-alpha-1");
  assert.equal(harness.data.workerCommandReceipts.length, 10);
  assert.equal(harness.data.workerEvents.length, 10);
  assert.deepEqual(
    harness.data.workerEvents.map((event) => event.sequence),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
});

test("idempotent lifecycle replay returns the original result and rejects key drift", async () => {
  const harness = createHarness();
  const input = {
    ...command("same-key"),
    definitionId: "worker-idempotent",
    versionId: "version-idempotent",
    name: "Idempotent Worker",
    description: "Exercises durable command replay.",
    content: content(),
    source: SOURCE,
  } as const;

  const first = await harness.service.createDefinition(input);
  const replay = await harness.service.createDefinition(input);

  assert.deepEqual(replay, first);
  assert.equal(harness.data.workerDefinitions.length, 1);
  assert.equal(harness.data.workerVersions.length, 1);
  assert.equal(harness.data.workerCommandReceipts.length, 1);
  assert.equal(harness.data.workerEvents.length, 1);

  await assert.rejects(
    harness.service.createDefinition({
      ...input,
      name: "Different input",
    }),
    (error: unknown) =>
      error instanceof WorkerLifecycleError && error.code === "idempotency_mismatch",
  );
  await assert.rejects(
    harness.service.createDefinition({
      ...input,
      actor: { type: "user", id: "different-actor" },
    }),
    (error: unknown) =>
      error instanceof WorkerLifecycleError && error.code === "idempotency_mismatch",
  );
});

test("validated versions are immutable and stale draft digests conflict", async () => {
  const harness = createHarness();
  const created = await createDefinition(harness);

  await assert.rejects(
    harness.service.updateDraftVersion({
      ...command("stale"),
      workerVersionId: created.version!.id,
      expectedContentDigest: "sha256:stale",
      content: content({ objective: "Stale edit." }),
    }),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "conflict",
  );

  const validated = await harness.service.validateVersion({
    ...command("validate"),
    workerVersionId: created.version!.id,
    expectedContentDigest: created.version!.contentDigest,
  });
  await assert.rejects(
    harness.service.updateDraftVersion({
      ...command("immutable"),
      workerVersionId: created.version!.id,
      expectedContentDigest: validated.version!.contentDigest,
      content: content({ objective: "Mutation after validation." }),
    }),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "conflict",
  );
});

test("deployment creation rejects a capability grant that broadens its version", async () => {
  const harness = createHarness();
  const created = await createDefinition(harness);
  const validated = await harness.service.validateVersion({
    ...command("validate-for-narrowing"),
    workerVersionId: created.version!.id,
    expectedContentDigest: created.version!.contentDigest,
  });

  await assert.rejects(
    harness.service.createDeployment({
      ...command("broad-deployment-grant"),
      workerVersionId: validated.version!.id,
      capabilityGrants: [
        {
          capabilityId: "release-read",
          verbs: ["GET"],
          resources: ["https://admin.example.test/*"],
          approval: "never",
        },
      ],
    }),
    (error: unknown) =>
      error instanceof WorkerLifecycleError &&
      error.code === "invalid_input" &&
      /outside the version request/.test(error.message),
  );
  assert.equal(harness.data.workerDeployments.length, 0);
});

test("deployment commands reject stale revisions and competing active deployments", async () => {
  const harness = createHarness();
  const first = await createActiveDeployment(harness, "1");
  const secondVersion = await harness.service.createVersion({
    ...command("v2-create"),
    workerDefinitionId: first.definition!.id,
    versionId: "version-alpha-2",
    content: content({ objective: "Second version objective." }),
    source: SOURCE,
  });
  const validatedV2 = await harness.service.validateVersion({
    ...command("v2-validate"),
    workerVersionId: secondVersion.version!.id,
    expectedContentDigest: secondVersion.version!.contentDigest,
  });
  const secondDraft = await harness.service.createDeployment({
    ...command("d2-create"),
    deploymentId: "deployment-alpha-2",
    workerVersionId: validatedV2.version!.id,
  });
  const secondValidated = await harness.service.validateDeployment({
    ...command("d2-validate"),
    workerDeploymentId: secondDraft.deployment!.id,
    expectedRevision: secondDraft.deployment!.revision,
  });
  const secondDeployed = await harness.service.deploy({
    ...command("d2-deploy"),
    workerDeploymentId: secondValidated.deployment!.id,
    expectedRevision: secondValidated.deployment!.revision,
  });

  await assert.rejects(
    harness.service.activate({
      ...command("d2-activate"),
      workerDeploymentId: secondDeployed.deployment!.id,
      expectedRevision: secondDeployed.deployment!.revision,
    }),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "conflict",
  );
  await assert.rejects(
    harness.service.pause({
      ...command("stale-revision"),
      workerDeploymentId: first.deployment!.id,
      expectedRevision: 1,
    }),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "conflict",
  );
});

test("rollback creates a replacement deployment pinned to an older validated version", async () => {
  const harness = createHarness();
  const first = await createActiveDeployment(harness, "1");
  const retiredFirst = await harness.service.retireDeployment({
    ...command("retire-v1"),
    workerDeploymentId: first.deployment!.id,
    expectedRevision: first.deployment!.revision,
  });
  assert.equal(retiredFirst.deployment?.status, "retired");

  const v2 = await harness.service.createVersion({
    ...command("v2"),
    workerDefinitionId: first.definition!.id,
    versionId: "version-alpha-2",
    content: content({ objective: "Second bounded release objective." }),
    source: SOURCE,
  });
  const validatedV2 = await harness.service.validateVersion({
    ...command("validate-v2"),
    workerVersionId: v2.version!.id,
    expectedContentDigest: v2.version!.contentDigest,
  });
  const d2 = await createActiveDeploymentForVersion(harness, validatedV2.version!.id, "2");

  const rolledBack = await harness.service.rollback({
    ...command("rollback"),
    workerDeploymentId: d2.deployment!.id,
    targetWorkerVersionId: first.version!.id,
    replacementDeploymentId: "deployment-alpha-rollback",
    expectedRevision: d2.deployment!.revision,
  });

  assert.equal(rolledBack.previousDeployment?.status, "retired");
  assert.equal(rolledBack.deployment?.status, "active");
  assert.equal(rolledBack.deployment?.workerVersionId, first.version?.id);
  assert.equal(rolledBack.definition?.currentVersionId, first.version?.id);
  assert.equal(rolledBack.rollout?.fromDeploymentId, d2.deployment?.id);
  assert.equal(rolledBack.rollout?.toDeploymentId, rolledBack.deployment?.id);
  assert.equal(harness.data.workerDeploymentRollouts.length, 1);
});

test("rollback rejects a newer target version", async () => {
  const harness = createHarness();
  const first = await createActiveDeployment(harness, "1");
  const secondVersion = await harness.service.createVersion({
    ...command("newer-v2-create"),
    workerDefinitionId: first.definition!.id,
    versionId: "version-alpha-2",
    content: content({ objective: "A newer version cannot be a rollback target." }),
    source: SOURCE,
  });
  const validatedV2 = await harness.service.validateVersion({
    ...command("newer-v2-validate"),
    workerVersionId: secondVersion.version!.id,
    expectedContentDigest: secondVersion.version!.contentDigest,
  });

  await assert.rejects(
    harness.service.rollback({
      ...command("invalid-newer-rollback"),
      workerDeploymentId: first.deployment!.id,
      targetWorkerVersionId: validatedV2.version!.id,
      expectedRevision: first.deployment!.revision,
    }),
    (error: unknown) =>
      error instanceof WorkerLifecycleError &&
      error.code === "conflict" &&
      /older validated version/.test(error.message),
  );
});

test("repository reads are workspace scoped", async () => {
  const harness = createHarness();
  await createDefinition(harness);

  assert.equal((await harness.service.listDefinitions("alpha")).length, 1);
  assert.equal((await harness.service.listDefinitions("beta")).length, 0);
  await assert.rejects(
    harness.service.getDefinition("beta", "worker-alpha"),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "not_found",
  );
});

interface Harness {
  readonly data: PacketAgentData;
  readonly service: ReturnType<typeof createWorkerLifecycleService>;
}

function createHarness(): Harness {
  const data = createSeedStore();
  let mutationChain: Promise<unknown> = Promise.resolve();
  const repository = createWorkerRepository({
    loadStore: () => data,
    mutateStore: <T>(mutator: (store: PacketAgentData) => T | Promise<T>) => {
      const result = mutationChain.then(() => mutator(data));
      mutationChain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  });
  const counts = new Map<string, number>();
  let tick = 0;
  return {
    data,
    service: createWorkerLifecycleService({
      repository,
      now: () => new Date(Date.UTC(2026, 6, 27, 12, 0, tick++)),
      id: (kind) => {
        const next = (counts.get(kind) ?? 0) + 1;
        counts.set(kind, next);
        return `${kind}-${next}`;
      },
    }),
  };
}

function command(idempotencyKey: string): WorkerCommandContext {
  return {
    workspaceId: "alpha",
    actor: ACTOR,
    idempotencyKey,
  };
}

function content(overrides: Partial<WorkerVersionContent> = {}): WorkerVersionContent {
  return makeWorkerVersionContent(overrides);
}

function createDefinition(harness: Harness) {
  return harness.service.createDefinition({
    ...command("definition"),
    definitionId: "worker-alpha",
    versionId: "version-alpha-1",
    name: "Release watcher",
    description: "Checks release readiness within explicit bounds.",
    content: content(),
    source: SOURCE,
  });
}

async function createActiveDeployment(harness: Harness, suffix: string) {
  const created = await createDefinition(harness);
  const validated = await harness.service.validateVersion({
    ...command(`validate-${suffix}`),
    workerVersionId: created.version!.id,
    expectedContentDigest: created.version!.contentDigest,
  });
  const active = await createActiveDeploymentForVersion(harness, validated.version!.id, suffix);
  return { ...active, definition: created.definition, version: validated.version };
}

async function createActiveDeploymentForVersion(
  harness: Harness,
  versionId: string,
  suffix: string,
) {
  const draft = await harness.service.createDeployment({
    ...command(`deployment-create-${suffix}`),
    deploymentId: `deployment-alpha-${suffix}`,
    workerVersionId: versionId,
  });
  const validated = await harness.service.validateDeployment({
    ...command(`deployment-validate-${suffix}`),
    workerDeploymentId: draft.deployment!.id,
    expectedRevision: draft.deployment!.revision,
  });
  const deployed = await harness.service.deploy({
    ...command(`deployment-deploy-${suffix}`),
    workerDeploymentId: validated.deployment!.id,
    expectedRevision: validated.deployment!.revision,
  });
  return harness.service.activate({
    ...command(`deployment-activate-${suffix}`),
    workerDeploymentId: deployed.deployment!.id,
    expectedRevision: deployed.deployment!.revision,
  });
}
