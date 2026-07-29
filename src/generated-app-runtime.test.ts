import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeneratedAppRuntimeArtifact,
  buildGeneratedAppRuntimeArtifactFromFiles,
  findGeneratedAppSourceFile,
  type GeneratedAppRuntimeDraft,
} from "./generated-app-runtime";

const draft: GeneratedAppRuntimeDraft = {
  prompt: "Build a CRM app for accounts and deals.",
  intent: "crm",
  summary: "A local CRM workspace with account CRUD.",
  app: {
    slug: "test-crm",
    name: "Test CRM",
    description: "Manage accounts locally.",
    pages: [
      {
        name: "Accounts",
        route: "/accounts",
        access: "private",
        purpose: "Manage account records.",
        actions: ["create account", "edit account", "archive account"],
        components: ["AccountList", "AccountEditor"],
      },
    ],
    dataSchema: [
      {
        name: "account",
        fields: [
          { name: "id", type: "uuid", required: true },
          { name: "name", type: "string", required: true },
          { name: "status", type: "enum", required: true },
          { name: "ownerEmail", type: "string", required: false },
        ],
        relationships: [],
      },
    ],
    apiRoutes: [
      {
        method: "GET",
        path: "/api/app/generated/test-crm/accounts",
        access: "private",
        purpose: "List accounts.",
        handler: "listAccounts",
        authRequired: true,
      },
      {
        method: "POST",
        path: "/api/app/generated/test-crm/accounts",
        access: "private",
        purpose: "Create account.",
        handler: "createAccount",
        authRequired: true,
      },
    ],
    crudFlows: [
      {
        entity: "account",
        create: "Create an account from the form.",
        read: "List seeded accounts.",
        update: "Edit account fields.",
        delete: "Archive account records.",
        validation: ["name is required"],
      },
    ],
    authDecisions: [],
  },
};

test("generated runtime emits a self-contained local CRUD app bundle", () => {
  const artifact = buildGeneratedAppRuntimeArtifact({
    appId: "gapp_test",
    workspaceId: "alpha",
    checkpointId: "ckpt_test",
    draft,
    renderedAt: "2026-05-12T12:00:00.000Z",
  });

  const paths = artifact.files.map((file) => file.path);
  assert.ok(paths.includes("src/App.tsx"));
  assert.ok(paths.includes("src/api/generated-api.ts"));
  assert.ok(paths.includes("src/data/schema.ts"));
  assert.ok(paths.includes("src/data/seed-data.json"));
  assert.ok(paths.includes("src/db/migrations/0001_initial.sql"));
  assert.ok(paths.includes("src/db/seed.ts"));
  assert.ok(paths.includes("tsconfig.json"));
  assert.ok(paths.includes("vite.config.ts"));

  const appFile = findGeneratedAppSourceFile(artifact, "src/App.tsx")?.content ?? "";
  assert.match(appFile, /listGeneratedRecords/);
  assert.match(appFile, /async function handleCreate/);
  assert.match(appFile, /async function handleEdit/);
  assert.match(appFile, /async function archiveRecord/);
  assert.match(appFile, /Dashboard summary/);
  assert.match(appFile, /Server runtime/);

  const apiFile = findGeneratedAppSourceFile(artifact, "src/api/generated-api.ts")?.content ?? "";
  assert.match(apiFile, /fetch\(runtimeApiUrl/);
  assert.match(apiFile, /createGeneratedRecord/);
  assert.match(apiFile, /updateGeneratedRecord/);
  assert.match(apiFile, /archiveGeneratedRecord/);

  const seedFile = findGeneratedAppSourceFile(artifact, "src/data/seed-data.json")?.content ?? "";
  assert.match(seedFile, /"account_001"/);
  assert.match(seedFile, /"name": "Account 1"/);

  const schemaFile = findGeneratedAppSourceFile(artifact, "src/data/schema.ts")?.content ?? "";
  assert.match(schemaFile, /primaryEntity/);
  assert.match(schemaFile, /editableFields/);
  assert.match(schemaFile, /server-sqlite/);

  const migrationFile =
    findGeneratedAppSourceFile(artifact, "src/db/migrations/0001_initial.sql")?.content ?? "";
  assert.match(migrationFile, /Reference DDL for an app-owned database/);
  assert.match(migrationFile, /do not\s+-- execute this file/);
  assert.match(migrationFile, /CREATE TABLE IF NOT EXISTS account/);
  assert.match(migrationFile, /archived BOOLEAN NOT NULL DEFAULT FALSE/);

  const packageFile = findGeneratedAppSourceFile(artifact, "package.json")?.content ?? "";
  assert.match(packageFile, /"build": "vite build"/);
  const readmeFile = findGeneratedAppSourceFile(artifact, "README.md")?.content ?? "";
  assert.match(readmeFile, /reset-and-reseed/);
  assert.match(readmeFile, /Automatic data-preserving migration is not implemented/);
});

test("generated runtime can wrap an LLM-authored file tree as the artifact", () => {
  const artifact = buildGeneratedAppRuntimeArtifactFromFiles(
    [
      { path: "index.html", content: '<div id="root"></div>' },
      { path: "src/App.tsx", content: "export default function App(){ return null; }" },
      { path: "tsconfig.json", content: "{}" },
    ],
    "2026-05-12T12:00:00.000Z",
  );

  assert.equal(artifact.entrypoint, "index.html");
  assert.equal(artifact.renderedAt, "2026-05-12T12:00:00.000Z");
  assert.equal(findGeneratedAppSourceFile(artifact, "src/App.tsx")?.role, "source");
  assert.equal(findGeneratedAppSourceFile(artifact, "tsconfig.json")?.role, "config");
  assert.equal(findGeneratedAppSourceFile(artifact, "index.html")?.role, "entrypoint");
  assert.match(findGeneratedAppSourceFile(artifact, "src/App.tsx")?.sha256 ?? "", /^[a-f0-9]{64}$/);
});
