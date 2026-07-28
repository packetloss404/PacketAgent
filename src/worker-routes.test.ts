import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "hono";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import { createWorkerRoutes, type AuthorizedWorkerRouteContext } from "./worker-routes.js";
import { WorkerLifecycleError } from "./workers/errors.js";
import { createWorkerRepository } from "./workers/repository.js";
import { createWorkerLifecycleService } from "./workers/service.js";
import { createWorkerActivationRepository } from "./workers/activation-repository.js";
import { createWorkerActivationService } from "./workers/activation.js";
import type { WorkerSourceProvenance, WorkerVersionContent } from "./workers/types.js";
import { makeWorkerVersionContent } from "./workers/__tests__/fixtures.js";
import { createWorkerCredentialService } from "./workers/credentials.js";

const SOURCE: WorkerSourceProvenance = {
  product: "PacketAgent",
  kind: "native",
};

test("Worker routes enforce role boundaries and preserve idempotent replay", async () => {
  const harness = createRouteHarness("member");
  const request = {
    definitionId: "worker-route",
    versionId: "worker-route-v1",
    name: "Route Worker",
    description: "Exercises the private lifecycle API.",
    content: makeWorkerVersionContent(),
    source: SOURCE,
  };

  const first = await postJson(harness.routes, "/definitions", request, "route-create");
  const replay = await postJson(harness.routes, "/definitions", request, "route-create");

  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), await first.json());
  assert.equal(harness.data.workerDefinitions.length, 1);
  assert.equal(harness.data.workerCommandReceipts.length, 1);
  assert.equal(harness.roles.includes("member"), true);

  const list = await harness.routes.request("/definitions");
  assert.equal(list.status, 200);
  assert.equal(harness.roles.at(-1), "viewer");

  const activation = await postJson(
    harness.routes,
    "/deployments/missing/activate",
    { expectedRevision: 1 },
    "route-activate",
  );
  assert.equal(activation.status, 403);
  assert.equal(harness.roles.at(-1), "admin");
});

test("Worker routes return stable validation and revision conflict codes", async () => {
  const harness = createRouteHarness("admin");
  const missingKey = await harness.routes.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Missing key",
      description: "Must be rejected.",
      content: makeWorkerVersionContent(),
      source: SOURCE,
    }),
  });
  assert.equal(missingKey.status, 400);
  assert.equal(((await missingKey.json()) as { code: string }).code, "invalid_input");

  const created = await createDefinitionThroughRoutes(harness);
  const version = created.version as { id: string; contentDigest: string };
  const validatedVersion = await postJson(
    harness.routes,
    `/versions/${version.id}/validate`,
    { expectedContentDigest: version.contentDigest },
    "validate-version",
  );
  assert.equal(validatedVersion.status, 200);

  const deploymentResponse = await postJson(
    harness.routes,
    "/deployments",
    {
      deploymentId: "worker-route-deployment",
      workerVersionId: version.id,
      capabilityGrants: [
        {
          capabilityId: "release-read",
          verbs: ["get"],
          resources: ["https://releases.example.test/releases"],
          approval: "always",
        },
      ],
    },
    "create-deployment",
  );
  const deployment = (
    (await deploymentResponse.json()) as {
      deployment: {
        id: string;
        revision: number;
        capabilityGrants: Array<{ resources: string[]; approval: string }>;
        compiledPolicy: { workerVersionContentDigest: string };
      };
    }
  ).deployment;
  assert.deepEqual(deployment.capabilityGrants, [
    {
      capabilityId: "release-read",
      verbs: ["GET"],
      resources: ["https://releases.example.test/releases"],
      approval: "always",
    },
  ]);
  assert.equal(deployment.compiledPolicy.workerVersionContentDigest, version.contentDigest);
  const validatedDeployment = await postJson(
    harness.routes,
    `/deployments/${deployment.id}/validate`,
    { expectedRevision: deployment.revision },
    "validate-deployment",
  );
  assert.equal(validatedDeployment.status, 200);

  const stale = await postJson(
    harness.routes,
    `/deployments/${deployment.id}/deploy`,
    { expectedRevision: deployment.revision },
    "stale-deploy",
  );
  const staleBody = (await stale.json()) as { code: string };
  assert.equal(stale.status, 409);
  assert.equal(staleBody.code, "conflict");
});

test("Worker credential routes are admin-only and return encrypted metadata without values", async () => {
  const harness = createRouteHarness("admin");
  const secret = JSON.stringify({
    schemaVersion: "packetagent.packetchat-route/v1",
    endpoint: "https://chat.example.test/api/worker-messages",
    callbackBaseUrl: "https://agent.example.test",
    callbackSecret: "callback-secret-that-is-longer-than-32-bytes",
  });
  const upserted = await harness.routes.request("/credentials", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reference: "vault:packetchat-operations",
      kind: "opaque",
      label: "PacketChat operations route",
      value: secret,
    }),
  });
  assert.equal(upserted.status, 200);
  const upsertBody = JSON.stringify(await upserted.json());
  assert.equal(upsertBody.includes(secret), false);
  assert.equal(upsertBody.includes("ciphertext"), false);
  assert.equal(JSON.stringify(harness.data).includes(secret), false);
  assert.ok(harness.data.workerCredentials[0]?.ciphertext);

  const listed = await harness.routes.request("/credentials");
  assert.equal(listed.status, 200);
  const listBody = JSON.stringify(await listed.json());
  assert.equal(listBody.includes(secret), false);
  assert.equal(listBody.includes("ciphertext"), false);
  assert.equal(harness.roles.at(-1), "admin");

  const removed = await harness.routes.request("/credentials", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: "vault:packetchat-operations" }),
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: true });
  assert.equal(harness.data.workerCredentials.length, 0);

  const member = createRouteHarness("member");
  const denied = await member.routes.request("/credentials");
  assert.equal(denied.status, 403);
  assert.equal(member.roles.at(-1), "admin");
});

test("Worker routes scope reads to the authorized workspace", async () => {
  const harness = createRouteHarness("admin");
  const created = await createDefinitionThroughRoutes(harness);
  const definitionId = (created.definition as { id: string }).id;

  harness.auth.workspaceId = "beta";
  const hidden = await harness.routes.request(`/definitions/${definitionId}`);
  assert.equal(hidden.status, 404);
  assert.equal(((await hidden.json()) as { code: string }).code, "not_found");
});

test("manual Worker run routes use the canonical activation inbox", async () => {
  const harness = createRouteHarness("admin");
  const created = await createDefinitionThroughRoutes(harness);
  const version = created.version as { id: string; contentDigest: string };
  await postJson(
    harness.routes,
    `/versions/${version.id}/validate`,
    { expectedContentDigest: version.contentDigest },
    "manual-validate-version",
  );
  const deploymentResponse = await postJson(
    harness.routes,
    "/deployments",
    {
      deploymentId: "manual-route-deployment",
      workerVersionId: version.id,
    },
    "manual-create-deployment",
  );
  let deployment = (
    (await deploymentResponse.json()) as {
      deployment: { id: string; revision: number };
    }
  ).deployment;
  for (const [action, key] of [
    ["validate", "manual-validate-deployment"],
    ["deploy", "manual-deploy"],
    ["activate", "manual-activate"],
  ] as const) {
    const response = await postJson(
      harness.routes,
      `/deployments/${deployment.id}/${action}`,
      { expectedRevision: deployment.revision },
      key,
    );
    deployment = (
      (await response.json()) as {
        deployment: { id: string; revision: number };
      }
    ).deployment;
  }

  const first = await postJson(
    harness.routes,
    `/deployments/${deployment.id}/runs`,
    { input: { release_id: "release-route" } },
    "manual-occurrence-1",
  );
  const replay = await postJson(
    harness.routes,
    `/deployments/${deployment.id}/runs`,
    { input: { release_id: "release-route" } },
    "manual-occurrence-1",
  );
  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.equal(
    ((await first.json()) as { runId: string }).runId,
    ((await replay.json()) as { runId: string }).runId,
  );
  assert.equal(harness.data.workerRuns.length, 1);
  assert.equal(harness.data.workerActivationInboxes[0].duplicateCount, 1);

  const listed = await harness.routes.request(
    `/activations?workerDeploymentId=${deployment.id}`,
  );
  assert.equal(listed.status, 200);
  assert.equal(
    ((await listed.json()) as { activations: unknown[] }).activations.length,
    1,
  );
});

test("Worker route errors redact secret-shaped values", async () => {
  const harness = createRouteHarness("admin");
  const service = {
    ...harness.service,
    async createDefinition() {
      throw new WorkerLifecycleError("invalid_input", "validation failed for api_key=super-secret");
    },
  };
  const routes = createWorkerRoutes({
    service,
    authorize: harness.authorize,
  });

  const response = await postJson(
    routes,
    "/definitions",
    {
      name: "Redaction",
      description: "Redacts validation errors.",
      content: makeWorkerVersionContent(),
      source: SOURCE,
    },
    "redact",
  );
  const body = (await response.json()) as { error: string; code: string };
  assert.equal(response.status, 400);
  assert.equal(body.code, "invalid_input");
  assert.equal(body.error.includes("super-secret"), false);
  assert.match(body.error, /\[redacted]/);
});

interface RouteHarness {
  readonly data: PacketAgentData;
  readonly service: ReturnType<typeof createWorkerLifecycleService>;
  readonly routes: ReturnType<typeof createWorkerRoutes>;
  readonly auth: { workspaceId: string; role: WorkerRouteRole };
  readonly roles: WorkerRouteRole[];
  readonly authorize: (
    context: Context,
    minimumRole: WorkerRouteRole,
  ) => Promise<AuthorizedWorkerRouteContext>;
}

type WorkerRouteRole = "viewer" | "member" | "admin";

function createRouteHarness(role: WorkerRouteRole): RouteHarness {
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
  let tick = 0;
  let id = 0;
  const service = createWorkerLifecycleService({
    repository,
    now: () => new Date(Date.UTC(2026, 6, 27, 13, 0, tick++)),
    id: (kind) => `${kind}-route-${++id}`,
  });
  const activationRepository = createWorkerActivationRepository({
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
  const activationService = createWorkerActivationService({
    repository: activationRepository,
    now: () => new Date(Date.UTC(2026, 6, 27, 14, 0, tick++)),
    id: (kind) => `${kind}-route-${++id}`,
  });
  const credentialService = createWorkerCredentialService({
    mutateStore: async (mutator) => mutator(data),
    masterKey: () => Buffer.alloc(32, 11),
    generateId: () => `credential-route-${++id}`,
    now: () => new Date(Date.UTC(2026, 6, 27, 15, 0, tick++)).toISOString(),
  });
  const auth = { workspaceId: "alpha", role };
  const roles: WorkerRouteRole[] = [];
  const authorize = async (
    _context: Context,
    minimumRole: WorkerRouteRole,
  ): Promise<AuthorizedWorkerRouteContext> => {
    roles.push(minimumRole);
    if (roleRank(auth.role) < roleRank(minimumRole)) {
      throw Object.assign(new Error(`workspace role ${minimumRole} is required`), {
        status: 403,
      });
    }
    return {
      workspaceId: auth.workspaceId,
      actor: {
        type: "user",
        id: "user-route",
        displayName: "Route User",
      },
    };
  };
  return {
    data,
    service,
    routes: createWorkerRoutes({
      service,
      activationService,
      credentialService,
      authorize,
    }),
    auth,
    roles,
    authorize,
  };
}

function roleRank(role: WorkerRouteRole): number {
  return { viewer: 0, member: 1, admin: 2 }[role];
}

async function createDefinitionThroughRoutes(harness: RouteHarness) {
  const response = await postJson(
    harness.routes,
    "/definitions",
    {
      definitionId: "worker-route",
      versionId: "worker-route-v1",
      name: "Route Worker",
      description: "Exercises route lifecycle behavior.",
      content: makeWorkerVersionContent(),
      source: SOURCE,
    },
    "create-definition",
  );
  assert.equal(response.status, 201);
  return (await response.json()) as {
    definition: { id: string };
    version: { id: string; contentDigest: string };
  };
}

function postJson(
  routes: ReturnType<typeof createWorkerRoutes>,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Response> {
  return Promise.resolve(
    routes.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  );
}
