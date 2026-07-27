# PacketADE to PacketAgent handoff

Status: design contract for backlog loop W9.

## Goal

PacketADE can hand durable work to PacketAgent without keeping PacketADE, its terminal, or its original conversation open.

Primary user actions:

- **Deploy to PacketAgent** creates or updates a durable Worker deployment.
- **Keep running** deploys, activates, and follows the Worker while PacketADE remains open.
- **Inspect in PacketAgent** opens the deployment, active run, evidence, and attention state.
- **Pause**, **resume**, and **revoke** operate on the durable deployment rather than a local UI process.

## WorkerPackage envelope

The wire format must be versioned, validated, integrity-protected, and idempotent.

```ts
interface WorkerPackage {
  schemaVersion: string;
  packageId: string;
  packageVersion: string;
  idempotencyKey: string;
  createdAt: string;
  createdBy: ActorReference;

  source: {
    product: "PacketADE";
    flightId?: string;
    issueId?: string;
    conversationId?: string;
    projectId?: string;
    repository?: string;
    revision?: string;
  };

  worker: {
    name: string;
    objective: string;
    instructions: string;
    providerProfile: string;
    executionTarget: ExecutionTargetReference;
    tools: ToolCapabilityRequest[];
    credentialRefs: string[];
    triggers: WorkerTrigger[];
    policy: WorkerPolicy;
    exitPredicates: ExitPredicate[];
    acceptanceCommands: string[];
    notificationRoutes: NotificationRouteReference[];
  };

  artifacts: ArtifactReference[];
  integrity: {
    algorithm: string;
    digest: string;
    signature?: string;
  };
}
```

Secret values are never part of the package. `credentialRefs` name PacketAgent-side vault entries that the receiving operator is authorized to resolve.

## Required policy

Every deployment declares:

- maximum elapsed time per run;
- maximum supervisor iterations;
- maximum provider cost or token budget;
- maximum consecutive failures and retry/backoff policy;
- allowed tools with verb/resource scopes;
- network, filesystem, shell, and external-write boundaries;
- an exit predicate;
- what requires approval; and
- where attention and terminal notifications go.

PacketAgent rejects activation if required bounds are absent.

## Lifecycle

```text
draft -> validated -> deployed -> active
                    |            |-> paused -> active
                    |            |-> attention -> active
                    |            |-> retired
                    |-> rejected
```

A deployment points to one immutable Worker version. Updating it creates a new version and an explicit rollout or rollback decision.

## API shape

Initial endpoints:

- `POST /api/worker-packages/validate`
- `POST /api/worker-deployments`
- `PUT /api/worker-deployments/:id`
- `POST /api/worker-deployments/:id/activate`
- `POST /api/worker-deployments/:id/pause`
- `POST /api/worker-deployments/:id/resume`
- `POST /api/worker-deployments/:id/revoke`
- `GET /api/worker-deployments/:id`
- `GET /api/worker-deployments/:id/runs`
- `GET /api/worker-runs/:id/events`

Write endpoints require an idempotency key. Package IDs, deployment IDs, and run IDs remain distinct.

## Events returned to PacketADE

PacketAgent emits versioned events:

- `worker.deployed`
- `worker.activated`
- `worker.run.started`
- `worker.run.progress`
- `worker.run.checkpointed`
- `worker.run.approval_required`
- `worker.run.blocked`
- `worker.run.completed`
- `worker.run.failed`
- `worker.run.budget_exhausted`
- `worker.run.cancelled`
- `worker.deployment.paused`
- `worker.deployment.revoked`

Each event includes deployment ID, Worker version, run ID when applicable, monotonic sequence, timestamp, trace ID, summary, and an evidence link. Consumers acknowledge a cursor so reconnecting does not lose events.

## Trust boundary

- PacketAgent validates schema and policy independently of PacketADE.
- Both sides authenticate the connection and bind actions to an actor/workspace.
- Package integrity and source provenance are recorded before activation.
- Requested capabilities are an upper bound, not an automatic grant.
- The receiving PacketAgent operator can narrow capabilities or reject deployment.
- Replayed packages and callbacks are safe through idempotency and expiry.

## Delivery order

1. Freeze the WorkerPackage schema alongside W1.
2. Implement validation without activation.
3. Implement deployment and inspection.
4. Add manual activation with bounded policies.
5. Add event streaming and PacketADE reconnection.
6. Add update, rollback, pause, and revoke.
7. Add PacketChat and PacketPhone notification routes after W7 is stable.
