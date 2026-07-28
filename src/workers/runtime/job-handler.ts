import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { JobHandlerContext } from "../../jobs/scheduler.js";
import { JobDeferredError, JobReleasedError } from "../../jobs/scheduler.js";
import type { JobRecord } from "../../packetagent-store.js";
import { redactedErrorMessage } from "../../security/redaction.js";
import { createWorkerActivationService, type WorkerActivationService } from "../activation.js";
import type { JsonObject } from "../types.js";
import {
  createSystemWorkerClock,
  createWorkerProviderPort,
  createWorkerToolPort,
} from "./adapters.js";
import type { WorkerSupervisorPorts } from "./ports.js";
import { createWorkerRuntimeRepository, type WorkerRuntimeRepository } from "./repository.js";
import { runWorkerSupervisor, WorkerRuntimeReleasedError } from "./supervisor.js";

export interface WorkerExecutionJobHandlerDependencies {
  readonly repository?: WorkerRuntimeRepository;
  readonly activationService?: WorkerActivationService;
  readonly ports?: Omit<
    WorkerSupervisorPorts,
    "checkpoints" | "events" | "leases" | "cancellation" | "runs"
  >;
  readonly ownerId?: (job: JobRecord) => string;
}

export function createWorkerExecutionJobHandler(
  dependencies: WorkerExecutionJobHandlerDependencies = {},
): {
  handle(job: JobRecord, context: JobHandlerContext): Promise<unknown>;
} {
  const repository = dependencies.repository ?? createWorkerRuntimeRepository();
  const activationService = dependencies.activationService ?? createWorkerActivationService();
  const runtimePorts =
    dependencies.ports ??
    ({
      provider: createWorkerProviderPort(),
      tools: createWorkerToolPort(),
      clock: createSystemWorkerClock(),
    } satisfies WorkerExecutionJobHandlerDependencies["ports"]);
  const ownerId =
    dependencies.ownerId ??
    ((job: JobRecord) => `${hostname()}:${process.pid}:${job.id}:${randomUUID()}`);

  return {
    async handle(job, context) {
      const workerRunId = requiredPayloadString(job, "workerRunId");
      const workerDeploymentId = requiredPayloadString(job, "workerDeploymentId");
      const workerVersionId = requiredPayloadString(job, "workerVersionId");
      const acquisition = await repository.acquire({
        workspaceId: job.workspaceId,
        workerRunId,
        ownerId: ownerId(job),
        now: runtimePorts.clock.now(),
      });
      if (acquisition.disposition === "busy") {
        throw new JobDeferredError(
          "Worker execution lease is held by another supervisor.",
          new Date(Math.max(Date.now() + 100, Date.parse(acquisition.retryAt))),
        );
      }
      if (acquisition.disposition === "terminal") {
        return {
          workerRunId: acquisition.run.id,
          status: acquisition.run.status,
          terminalReason: acquisition.run.terminalReason,
          duplicateExecution: true,
        };
      }
      if (
        acquisition.context.run.workerDeploymentId !== workerDeploymentId ||
        acquisition.context.run.workerVersionId !== workerVersionId
      ) {
        await repository.release({
          workspaceId: job.workspaceId,
          workerRunId,
          lease: acquisition.lease,
          now: runtimePorts.clock.now(),
        });
        throw new Error("Worker execution job does not match its version-pinned run.");
      }

      let resolvedInput: JsonObject = acquisition.context.input;
      let startupError: string | undefined;
      if (acquisition.context.run.inputReference) {
        try {
          resolvedInput = await activationService.resolvePayload(
            job.workspaceId,
            acquisition.context.run.inputReference,
          );
        } catch (error) {
          startupError = redactedErrorMessage(error);
        }
      }

      const ports: WorkerSupervisorPorts = {
        ...runtimePorts,
        checkpoints: repository,
        events: repository,
        leases: repository,
        cancellation: repository,
        runs: repository,
      };
      try {
        const result = await runWorkerSupervisor({
          context: {
            ...acquisition.context,
            input: resolvedInput,
          },
          lease: acquisition.lease,
          ports,
          signal: context.signal,
          ...(startupError ? { startupError } : {}),
        });
        return {
          workerRunId: result.run.id,
          status: result.run.status,
          terminalReason: result.run.terminalReason,
          budgetUsage: result.run.budgetUsage,
        };
      } catch (error) {
        await repository
          .release({
            workspaceId: job.workspaceId,
            workerRunId,
            lease: acquisition.lease,
            now: runtimePorts.clock.now(),
          })
          .catch(() => undefined);
        if (error instanceof WorkerRuntimeReleasedError) {
          throw new JobReleasedError(error.message);
        }
        throw error;
      }
    },
  };
}

function requiredPayloadString(job: JobRecord, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Worker execution job is missing ${key}.`);
  }
  return value;
}
