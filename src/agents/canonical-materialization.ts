import { createHash } from "node:crypto";
import type { AgentRecord, ProviderRecord } from "../packetagent-store.js";
import { WorkerLifecycleError } from "../workers/errors.js";
import { createWorkerLifecycleService, type WorkerLifecycleService } from "../workers/service.js";
import {
  isTerminalWorkerDeploymentStatus,
  type WorkerActorReference,
  type WorkerDeployment,
  type WorkerReadModelProjection,
  type WorkerVersion,
} from "../workers/index.js";
import { projectLegacyAgentToExecutableWorker } from "./canonical-projection.js";

const MIGRATION_ACTOR: WorkerActorReference = {
  type: "system",
  id: "packetagent.legacy-agent-migration",
  displayName: "PacketAgent legacy Agent migration",
};

export interface CanonicalAgentMaterialization {
  readonly projection: WorkerReadModelProjection;
  readonly version: WorkerVersion;
  readonly deployment: WorkerDeployment;
  readonly createdVersion: boolean;
}

export interface CanonicalAgentMaterializationDependencies {
  readonly lifecycle?: WorkerLifecycleService;
}

export async function materializeLegacyAgentWorker(
  agent: AgentRecord,
  provider: ProviderRecord | null,
  dependencies: CanonicalAgentMaterializationDependencies = {},
): Promise<CanonicalAgentMaterialization> {
  if (agent.status === "archived") {
    throw new WorkerLifecycleError(
      "invalid_transition",
      "An archived Agent cannot be materialized for execution.",
    );
  }
  const lifecycle = dependencies.lifecycle ?? createWorkerLifecycleService();
  const projection = projectLegacyAgentToExecutableWorker(agent, provider);
  const definitionId = projection.definition.id;
  let detail = await findDefinition(lifecycle, agent.workspaceId, definitionId);
  let createdVersion = false;

  if (!detail) {
    const created = await lifecycle.createDefinition({
      workspaceId: agent.workspaceId,
      actor: MIGRATION_ACTOR,
      idempotencyKey: commandKey(agent.id, "definition.create", projection.version.contentDigest),
      definitionId,
      versionId: versionId(agent.id, projection.version.contentDigest),
      name: agent.name,
      description: agent.description.trim() || agent.name,
      content: projection.version.content,
      source: projection.version.source,
    });
    if (!created.version) {
      throw new WorkerLifecycleError(
        "integrity",
        "Legacy Agent materialization did not create its initial Worker version.",
      );
    }
    createdVersion = true;
    detail = await lifecycle.getDefinition(agent.workspaceId, definitionId);
  }

  if (detail.definition.status === "retired") {
    throw new WorkerLifecycleError(
      "conflict",
      "The canonical Worker linked to this Agent is retired.",
    );
  }
  const description = agent.description.trim() || agent.name;
  if (detail.definition.name !== agent.name || detail.definition.description !== description) {
    await lifecycle.updateDefinition({
      workspaceId: agent.workspaceId,
      actor: MIGRATION_ACTOR,
      idempotencyKey: commandKey(
        agent.id,
        "definition.update",
        `${agent.name}\u001f${description}`,
      ),
      workerDefinitionId: definitionId,
      expectedUpdatedAt: detail.definition.updatedAt,
      name: agent.name,
      description,
    });
    detail = await lifecycle.getDefinition(agent.workspaceId, definitionId);
  }

  let version = detail.versions.find(
    (candidate) => candidate.contentDigest === projection.version.contentDigest,
  );
  if (!version) {
    const created = await lifecycle.createVersion({
      workspaceId: agent.workspaceId,
      actor: MIGRATION_ACTOR,
      idempotencyKey: commandKey(agent.id, "version.create", projection.version.contentDigest),
      workerDefinitionId: definitionId,
      versionId: versionId(agent.id, projection.version.contentDigest),
      content: projection.version.content,
      source: projection.version.source,
    });
    if (!created.version) {
      throw new WorkerLifecycleError(
        "integrity",
        "Legacy Agent materialization did not create its Worker version.",
      );
    }
    version = created.version;
    createdVersion = true;
  }
  if (version.status === "draft") {
    const validated = await lifecycle.validateVersion({
      workspaceId: agent.workspaceId,
      actor: MIGRATION_ACTOR,
      idempotencyKey: commandKey(agent.id, "version.validate", version.contentDigest),
      workerVersionId: version.id,
      expectedContentDigest: version.contentDigest,
    });
    if (!validated.version) {
      throw new WorkerLifecycleError(
        "integrity",
        "Legacy Agent materialization did not validate its Worker version.",
      );
    }
    version = validated.version;
  }
  if (version.status !== "validated") {
    throw new WorkerLifecycleError(
      "conflict",
      `The canonical Worker version linked to this Agent is ${version.status}.`,
    );
  }

  detail = await lifecycle.getDefinition(agent.workspaceId, definitionId);
  let deployment = selectVersionDeployment(detail.deployments, version.id);
  if (!deployment) {
    const previous = selectRolloutSource(detail.deployments);
    if (previous && previous.workerVersionId !== version.id) {
      const rolled = await lifecycle.updateDeployment({
        workspaceId: agent.workspaceId,
        actor: MIGRATION_ACTOR,
        idempotencyKey: commandKey(
          agent.id,
          "deployment.update",
          `${previous.id}:${version.contentDigest}`,
        ),
        workerDeploymentId: previous.id,
        expectedRevision: previous.revision,
        targetWorkerVersionId: version.id,
        replacementDeploymentId: deploymentId(agent.id, version.contentDigest),
        statusReason: "Legacy Agent content changed.",
      });
      if (!rolled.deployment) {
        throw new WorkerLifecycleError(
          "integrity",
          "Legacy Agent rollout did not create its replacement deployment.",
        );
      }
      deployment = rolled.deployment;
    } else {
      const created = await lifecycle.createDeployment({
        workspaceId: agent.workspaceId,
        actor: MIGRATION_ACTOR,
        idempotencyKey: commandKey(agent.id, "deployment.create", version.contentDigest),
        deploymentId: deploymentId(agent.id, version.contentDigest),
        workerVersionId: version.id,
      });
      if (!created.deployment) {
        throw new WorkerLifecycleError(
          "integrity",
          "Legacy Agent materialization did not create its Worker deployment.",
        );
      }
      deployment = created.deployment;
    }
  }

  deployment = await moveDeploymentToStatus(
    lifecycle,
    agent,
    deployment,
    agent.status === "active" ? "active" : "paused",
  );
  return { projection, version, deployment, createdVersion };
}

async function findDefinition(
  lifecycle: WorkerLifecycleService,
  workspaceId: string,
  definitionId: string,
) {
  try {
    return await lifecycle.getDefinition(workspaceId, definitionId);
  } catch (error) {
    if (error instanceof WorkerLifecycleError && error.code === "not_found") return null;
    throw error;
  }
}

function selectVersionDeployment(
  deployments: readonly WorkerDeployment[],
  versionId: string,
): WorkerDeployment | undefined {
  return deployments
    .filter(
      (deployment) =>
        deployment.workerVersionId === versionId &&
        !isTerminalWorkerDeploymentStatus(deployment.status),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function selectRolloutSource(
  deployments: readonly WorkerDeployment[],
): WorkerDeployment | undefined {
  return deployments
    .filter(
      (deployment) =>
        !isTerminalWorkerDeploymentStatus(deployment.status) &&
        ["deployed", "active", "paused"].includes(deployment.status),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

async function moveDeploymentToStatus(
  lifecycle: WorkerLifecycleService,
  agent: AgentRecord,
  initial: WorkerDeployment,
  desired: "active" | "paused",
): Promise<WorkerDeployment> {
  let deployment = initial;
  for (let transition = 0; transition < 5; transition += 1) {
    if (deployment.status === desired) return deployment;
    const input = {
      workspaceId: agent.workspaceId,
      actor: MIGRATION_ACTOR,
      workerDeploymentId: deployment.id,
      expectedRevision: deployment.revision,
    } as const;
    const result =
      deployment.status === "draft"
        ? await lifecycle.validateDeployment({
            ...input,
            idempotencyKey: transitionKey(agent.id, deployment, "validate"),
          })
        : deployment.status === "validated"
          ? await lifecycle.deploy({
              ...input,
              idempotencyKey: transitionKey(agent.id, deployment, "deploy"),
            })
          : deployment.status === "deployed"
            ? await lifecycle.activate({
                ...input,
                idempotencyKey: transitionKey(agent.id, deployment, "activate"),
              })
            : deployment.status === "active" && desired === "paused"
              ? await lifecycle.pause({
                  ...input,
                  idempotencyKey: transitionKey(agent.id, deployment, "pause"),
                })
              : (deployment.status === "paused" || deployment.status === "attention") &&
                  desired === "active"
                ? await lifecycle.resume({
                    ...input,
                    idempotencyKey: transitionKey(agent.id, deployment, "resume"),
                  })
                : null;
    if (!result?.deployment) {
      throw new WorkerLifecycleError(
        "invalid_transition",
        `Cannot move legacy Agent deployment from ${deployment.status} to ${desired}.`,
      );
    }
    deployment = result.deployment;
  }
  throw new WorkerLifecycleError("integrity", `Legacy Agent deployment did not reach ${desired}.`);
}

function transitionKey(agentId: string, deployment: WorkerDeployment, operation: string): string {
  return commandKey(agentId, `deployment.${operation}`, `${deployment.id}:${deployment.revision}`);
}

function versionId(agentId: string, digest: string): string {
  return `compat:agent:${agentId}:version:${digestToken(digest)}`;
}

function deploymentId(agentId: string, digest: string): string {
  return `compat:agent:${agentId}:deployment:${digestToken(digest)}`;
}

function digestToken(digest: string): string {
  return digest.replace(/^sha256:/, "").slice(0, 32);
}

function commandKey(agentId: string, operation: string, intent: string): string {
  const digest = createHash("sha256")
    .update(`${agentId}\u001f${operation}\u001f${intent}`)
    .digest("hex");
  return `legacy-agent:${operation}:${digest}`;
}
