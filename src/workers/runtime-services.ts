import type { WorkerCredentialKind, WorkerCredentialMetadata } from "./credential-types.js";
import type { WorkerNetworkPort } from "./network.js";
import type { WorkerSandboxPort } from "./sandbox-execution.js";

export interface BoundWorkerCredentialPort {
  use<TResult>(
    reference: string,
    expectedKinds: readonly WorkerCredentialKind[],
    consumer: (value: string, metadata: WorkerCredentialMetadata) => Promise<TResult> | TResult,
  ): Promise<TResult>;
}

export interface WorkerToolRuntimeServices {
  readonly credentials: BoundWorkerCredentialPort;
  readonly network: WorkerNetworkPort;
  readonly sandbox: WorkerSandboxPort;
}
