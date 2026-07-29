import assert from "node:assert/strict";
import test from "node:test";
import { deriveDraftFromFiles } from "./derived-draft.js";
import type { GeneratedFile } from "./llm-author.js";

const APP_TSX = `export default function MyDashboard() {
  return <div>hello</div>;
}
`;

test("derives appName from package.json", () => {
  const files: GeneratedFile[] = [
    { path: "package.json", content: JSON.stringify({ name: "billing-portal" }) },
    { path: "src/App.tsx", content: APP_TSX },
  ];
  const draft = deriveDraftFromFiles(files, "Build a billing portal", "A portal");
  assert.equal(draft.appName, "Billing Portal");
  assert.equal(draft.prompt, "Build a billing portal");
  assert.equal(draft.summary, "A portal");
  // Default page when there are no src/pages files.
  assert.ok(draft.pageMap.length >= 1);
  assert.ok(
    draft.pageMap.some((p) => p.path === "/"),
    "expected a root page",
  );
  // Auth, data schema, and integration metadata default to valid empty shapes.
  assert.equal(draft.dataSchema.database, "postgres");
  assert.deepEqual(draft.integrationMetadata.requested, []);
});

test("derives multiple pages when src/pages/* is present", () => {
  const files: GeneratedFile[] = [
    { path: "package.json", content: JSON.stringify({ name: "site" }) },
    { path: "src/App.tsx", content: APP_TSX },
    { path: "src/pages/index.tsx", content: "export default function Home() { return null; }" },
    { path: "src/pages/about.tsx", content: "export default function About() { return null; }" },
    {
      path: "src/pages/users/[id].tsx",
      content: "export default function User() { return null; }",
    },
  ];
  const draft = deriveDraftFromFiles(files, "Build a site", "");
  const paths = draft.pageMap.map((p) => p.path).sort();
  assert.ok(paths.includes("/"), `expected '/' in ${paths.join(",")}`);
  assert.ok(paths.includes("/about"), `expected '/about' in ${paths.join(",")}`);
  assert.ok(paths.includes("/users/:id"), `expected '/users/:id' in ${paths.join(",")}`);
});

test("returns a minimal valid draft when given an empty file tree", () => {
  const draft = deriveDraftFromFiles([], "Build something", "");
  // It does not throw and it returns sensible defaults.
  assert.equal(typeof draft.appName, "string");
  assert.ok(draft.appName.length > 0);
  assert.equal(draft.prompt, "Build something");
  assert.ok(Array.isArray(draft.pageMap));
  assert.ok(Array.isArray(draft.components));
  assert.ok(Array.isArray(draft.apiRouteStubs));
  assert.equal(draft.dataSchema.database, "postgres");
  assert.deepEqual(draft.dataSchema.entities, []);
  assert.deepEqual(draft.integrationMetadata.requested, []);
  assert.equal(draft.auth.defaultPolicy, "authenticated-by-default");
});

test("derives api route stubs from src/api/*", () => {
  const files: GeneratedFile[] = [
    { path: "package.json", content: JSON.stringify({ name: "api-app" }) },
    { path: "src/App.tsx", content: APP_TSX },
    { path: "src/api/users.ts", content: "export function POST() {}" },
  ];
  const draft = deriveDraftFromFiles(files, "Build an API app", "");
  assert.ok(draft.apiRouteStubs.length === 1);
  assert.equal(draft.apiRouteStubs[0].path, "/api/users");
  assert.equal(draft.apiRouteStubs[0].method, "POST");
});

test("derives data schema entities from src/data/*", () => {
  const files: GeneratedFile[] = [
    { path: "package.json", content: JSON.stringify({ name: "schemaful" }) },
    { path: "src/App.tsx", content: APP_TSX },
    { path: "src/data/customer.ts", content: "export type Customer = { id: string };" },
    { path: "src/data/order.ts", content: "export type Order = { id: string };" },
  ];
  const draft = deriveDraftFromFiles(files, "Build a schemaful app", "");
  const names = draft.dataSchema.entities.map((e) => e.name).sort();
  assert.deepEqual(names, ["customer", "order"]);
  assert.equal(draft.crudFlows.length, 2);
});

test("falls back to App component name when package.json has no name", () => {
  const files: GeneratedFile[] = [
    { path: "package.json", content: JSON.stringify({}) },
    { path: "src/App.tsx", content: "export default function FleetTracker() { return null; }" },
  ];
  const draft = deriveDraftFromFiles(files, "Build something", "");
  assert.equal(draft.appName, "Fleet Tracker");
});
