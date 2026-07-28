import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "hono";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import { createWorkerRoutes, type AuthorizedWorkerRouteContext } from "./worker-routes.js";
import { WorkerLifecycleError } from "./workers/errors.js";
import { createWorkerRepository } from "./workers/repository.js";
import { createWorkerLifecycleService } from "./workers/service.js";
import type { WorkerSourceProvenance, WorkerVersionContent } from "./workers/types.js";
import { makeWorkerVersionContent } from "./workers/__tests__/fixtures.js";

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
    },
    "create-deployment",
  );
  const deployment = (
    (await deploymentResponse.json()) as {
      deployment: { id: string; revision: number };
    }
  ).deployment;
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

test("Worker routes scope reads to the authorized workspace", async () => {
  const harness = createRouteHarness("admin");
  const created = await createDefinitionThroughRoutes(harness);
  const definitionId = (created.definition as { id: string }).id;

  harness.auth.workspaceId = "beta";
  const hidden = await harness.routes.request(`/definitions/${definitionId}`);
  assert.equal(hidden.status, 404);
  assert.equal(((await hidden.json()) as { code: string }).code, "not_found");
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
    routes: createWorkerRoutes({ service, authorize }),
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
