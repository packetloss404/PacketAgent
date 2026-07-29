import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils";
import { login } from "./packetagent-services";
import { resetStoreForTests } from "./packetagent-store";
import { publicShareRoutes, shareRoutes } from "./share-routes";

function createTestApp() {
  const app = new Hono();
  app.route("/api/app/share", shareRoutes);
  app.route("/api/public/share", publicShareRoutes);
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

test("share token list returns previews while create returns the one-time token", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const created = await app.request("/api/app/share", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ scope: "overview" }),
  });
  const createdBody = (await created.json()) as {
    token: { id: string; token?: string; tokenPreview?: string; scope: string };
  };

  assert.equal(created.status, 201);
  assert.equal(createdBody.token.scope, "overview");
  assert.ok(createdBody.token.token);
  assert.ok(createdBody.token.tokenPreview);

  const listed = await app.request("/api/app/share", { headers: authHeaders(alpha.cookieValue) });
  const listedBody = (await listed.json()) as {
    tokens: Array<{ id: string; token?: string; tokenPreview?: string }>;
  };
  const listedToken = listedBody.tokens.find((entry) => entry.id === createdBody.token.id);

  assert.equal(listed.status, 200);
  assert.equal(listedToken?.token, undefined);
  assert.equal(listedToken?.tokenPreview, createdBody.token.tokenPreview);
  assert.equal(JSON.stringify(listedBody).includes(createdBody.token.token!), false);

  const publicRead = await app.request(`/api/public/share/${createdBody.token.token}`);
  assert.equal(publicRead.status, 200);
});
