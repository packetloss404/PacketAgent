import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import { apiKeyRoutes } from "./api-key-routes.js";
import { listApiKeysForWorkspace, upsertApiKey } from "./security/api-key-store.js";
import { login } from "./packetagent-services.js";
import { mutateStore, resetStoreForTests } from "./packetagent-store.js";

function createTestApp() {
  const app = new Hono();
  app.route("/api/app/api-keys", apiKeyRoutes);
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

test("api key reads allow viewers but management requires admin", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  mutateStore((data) => {
    const membership = data.memberships.find(
      (entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha",
    );
    assert.ok(membership);
    membership.role = "viewer";
  });

  const listResponse = await app.request("/api/app/api-keys", {
    headers: authHeaders(alpha.cookieValue),
  });
  const createResponse = await app.request("/api/app/api-keys", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ provider: "openai", label: "OpenAI", value: "sk-test" }),
  });
  const deleteResponse = await app.request("/api/app/api-keys/some-key", {
    method: "DELETE",
    headers: authHeaders(alpha.cookieValue),
  });

  assert.equal(listResponse.status, 200);
  assert.equal(createResponse.status, 403);
  assert.deepEqual(await createResponse.json(), { error: "workspace role admin is required" });
  assert.equal(deleteResponse.status, 403);
  assert.deepEqual(await deleteResponse.json(), { error: "workspace role admin is required" });
});

test("api key deletion is scoped to the authenticated workspace", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const betaKey = upsertApiKey({
    workspaceId: "beta",
    provider: "openai",
    label: "Beta OpenAI",
    value: "sk-beta",
  });

  const response = await app.request(`/api/app/api-keys/${betaKey.id}`, {
    method: "DELETE",
    headers: authHeaders(alpha.cookieValue),
  });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "api key not found" });
  assert.ok(listApiKeysForWorkspace("beta").some((key) => key.id === betaKey.id));
});
