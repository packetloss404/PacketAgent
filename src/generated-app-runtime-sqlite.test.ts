import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildGeneratedAppRuntimeModel,
  type GeneratedAppRuntimeDraft,
} from "./generated-app-runtime.js";
import { openGeneratedAppSqliteRuntime } from "./generated-app-runtime/sqlite.js";

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

test("generated app SQLite runtime persists CRUD records across opens", () => {
  const root = mkdtempSync(join(tmpdir(), "packetagent-generated-runtime-"));
  try {
    const dbPath = join(root, "runtime.sqlite");
    const model = buildGeneratedAppRuntimeModel(draft);
    let runtime = openGeneratedAppSqliteRuntime({
      appId: "gapp_runtime",
      workspaceId: "alpha",
      model,
      dbPath,
    });
    const seeded = runtime.handleRequest({ method: "GET", path: "/accounts" });
    assert.equal(seeded.status, 200);
    assert.equal((seeded.body as unknown[]).length, 2);

    const created = runtime.handleRequest({
      method: "POST",
      path: "/accounts",
      body: { name: "Prairie Systems", status: "active" },
    });
    assert.equal(created.status, 201);
    const createdId = String((created.body as { id: string }).id);
    runtime.close();

    runtime = openGeneratedAppSqliteRuntime({
      appId: "gapp_runtime",
      workspaceId: "alpha",
      model,
      dbPath,
    });
    const reopened = runtime.handleRequest({ method: "GET", path: `/accounts/${createdId}` });
    assert.equal(reopened.status, 200);
    assert.equal((reopened.body as { name?: string }).name, "Prairie Systems");

    const updated = runtime.handleRequest({
      method: "PATCH",
      path: `/accounts/${createdId}`,
      body: { status: "pending" },
    });
    assert.equal((updated.body as { status?: string }).status, "pending");

    const archived = runtime.handleRequest({ method: "DELETE", path: `/accounts/${createdId}` });
    assert.equal(archived.status, 200);
    const listed = runtime.handleRequest({ method: "GET", path: "/accounts" });
    assert.equal(
      (listed.body as Array<{ id?: string }>).some((record) => record.id === createdId),
      false,
    );
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated app SQLite runtime drops and reseeds data on schema signature change", () => {
  const root = mkdtempSync(join(tmpdir(), "packetagent-generated-runtime-"));
  try {
    const dbPath = join(root, "runtime.sqlite");
    const model = buildGeneratedAppRuntimeModel(draft);
    let runtime = openGeneratedAppSqliteRuntime({
      appId: "gapp_runtime",
      workspaceId: "alpha",
      model,
      dbPath,
    });
    runtime.handleRequest({
      method: "POST",
      path: "/accounts",
      body: { name: "Transient Co", status: "active" },
    });
    runtime.close();

    const changedDraft: GeneratedAppRuntimeDraft = {
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
    };
    runtime = openGeneratedAppSqliteRuntime({
      appId: "gapp_runtime",
      workspaceId: "alpha",
      model: buildGeneratedAppRuntimeModel(changedDraft),
      dbPath,
    });
    const listed = runtime.handleRequest({ method: "GET", path: "/accounts" });
    assert.equal(
      (listed.body as Array<{ name?: string }>).some((record) => record.name === "Transient Co"),
      false,
    );
    assert.equal((listed.body as unknown[]).length, 2);
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
