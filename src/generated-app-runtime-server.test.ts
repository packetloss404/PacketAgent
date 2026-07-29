import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeneratedAppRuntimeModel,
  type GeneratedAppRuntimeDraft,
} from "./generated-app-runtime.js";
import {
  GeneratedAppRuntimeProcessPool,
  type GeneratedAppRuntimeWorkerFactory,
} from "./generated-app-runtime/server.js";

const draft: GeneratedAppRuntimeDraft = {
  prompt: "Build a CRM app.",
  intent: "crm",
  summary: "A CRM with persistent accounts.",
  app: {
    slug: "runtime-crm",
    name: "Runtime CRM",
    description: "Manage accounts.",
    pages: [],
    dataSchema: [
      {
        name: "account",
        fields: [
          { name: "id", type: "uuid", required: true },
          { name: "name", type: "string", required: true },
          { name: "status", type: "enum", required: true },
        ],
        relationships: [],
      },
    ],
    apiRoutes: [],
    crudFlows: [
      {
        entity: "account",
        create: "Create accounts.",
        read: "Read accounts.",
        update: "Update accounts.",
        delete: "Archive accounts.",
        validation: ["name is required"],
      },
    ],
    authDecisions: [],
  },
};

test("generated app runtime process pool reuses a warm worker for the same app schema", async (t) => {
  let starts = 0;
  const pool = new GeneratedAppRuntimeProcessPool({
    workerFactory: async () => {
      starts += 1;
      return {
        pid: 10_000 + starts,
        startedAt: `2026-05-18T12:00:0${starts}.000Z`,
        request: async () => ({ status: 200, body: { ok: true } }),
        stop: async () => undefined,
      };
    },
  });
  t.after(() => pool.shutdown());

  const model = buildGeneratedAppRuntimeModel(draft);
  await pool.request({
    appId: "gapp_1",
    workspaceId: "alpha",
    model,
    method: "GET",
    path: "account",
  });
  const second = await pool.request({
    appId: "gapp_1",
    workspaceId: "alpha",
    model,
    method: "GET",
    path: "account",
  });

  assert.equal(starts, 1);
  assert.equal(second.process.pid, 10_001);
  assert.equal(pool.snapshot().length, 1);
});

test("generated app runtime process pool restarts an app when the schema signature changes", async (t) => {
  const stops: string[] = [];
  let starts = 0;
  const pool = new GeneratedAppRuntimeProcessPool({
    workerFactory: async (config) => {
      starts += 1;
      return {
        pid: 20_000 + starts,
        startedAt: `2026-05-18T12:00:0${starts}.000Z`,
        request: async () => ({ status: 200, body: { schemaSignature: config.schemaSignature } }),
        stop: async (reason) => {
          stops.push(reason ?? "");
        },
      };
    },
  });
  t.after(() => pool.shutdown());

  const model = buildGeneratedAppRuntimeModel(draft);
  await pool.request({
    appId: "gapp_1",
    workspaceId: "alpha",
    model,
    method: "GET",
    path: "account",
  });
  const changedModel = buildGeneratedAppRuntimeModel({
    ...draft,
    app: {
      ...draft.app,
      dataSchema: [
        {
          ...draft.app.dataSchema[0]!,
          fields: [
            ...draft.app.dataSchema[0]!.fields,
            { name: "ownerEmail", type: "string", required: false },
          ],
        },
      ],
    },
  });
  const changed = await pool.request({
    appId: "gapp_1",
    workspaceId: "alpha",
    model: changedModel,
    method: "GET",
    path: "account",
  });

  assert.equal(starts, 2);
  assert.equal(changed.process.pid, 20_002);
  assert.ok(stops.includes("schema-changed"));
});

test("generated app runtime process pool evicts least-recently-used workers", async (t) => {
  const stoppedApps: string[] = [];
  let starts = 0;
  let clock = Date.parse("2026-05-18T12:00:00.000Z");
  const pool = new GeneratedAppRuntimeProcessPool({
    maxProcesses: 2,
    now: () => new Date((clock += 1000)),
    workerFactory: async (config) => {
      starts += 1;
      return {
        pid: 30_000 + starts,
        startedAt: new Date(clock).toISOString(),
        request: async () => ({ status: 200, body: { appId: config.appId } }),
        stop: async () => {
          stoppedApps.push(config.appId);
        },
      };
    },
  });
  t.after(() => pool.shutdown());

  const model = buildGeneratedAppRuntimeModel(draft);
  await pool.request({
    appId: "gapp_a",
    workspaceId: "alpha",
    model,
    method: "GET",
    path: "account",
  });
  await pool.request({
    appId: "gapp_b",
    workspaceId: "alpha",
    model,
    method: "GET",
    path: "account",
  });
  await pool.request({
    appId: "gapp_c",
    workspaceId: "alpha",
    model,
    method: "GET",
    path: "account",
  });

  assert.equal(starts, 3);
  assert.deepEqual(stoppedApps, ["gapp_a"]);
  assert.deepEqual(
    pool
      .snapshot()
      .map((entry) => entry.appId)
      .sort(),
    ["gapp_b", "gapp_c"],
  );
});

test("generated app runtime process pool restarts and retries after a worker crash", async (t) => {
  let starts = 0;
  const workerFactory: GeneratedAppRuntimeWorkerFactory = async () => {
    starts += 1;
    const workerNumber = starts;
    return {
      pid: 40_000 + starts,
      startedAt: `2026-05-18T12:00:0${starts}.000Z`,
      request: async () => {
        if (workerNumber === 1) throw new Error("worker crashed");
        return { status: 200, body: { recovered: true } };
      },
      stop: async () => undefined,
    };
  };
  const pool = new GeneratedAppRuntimeProcessPool({ workerFactory });
  t.after(() => pool.shutdown());

  const model = buildGeneratedAppRuntimeModel(draft);
  const result = await pool.request({
    appId: "gapp_1",
    workspaceId: "alpha",
    model,
    method: "GET",
    path: "account",
  });

  assert.equal(starts, 2);
  assert.equal((result.body as { recovered?: boolean }).recovered, true);
  assert.equal(result.process.restarts, 1);
});
