import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import { login } from "./packetagent-services.js";
import { resetStoreForTests } from "./packetagent-store.js";
import { app, artifactRunBelongsToWorkspace, artifactServingEnabled } from "./server.js";

test("artifact serving is disabled by default in production", () => {
  assert.equal(artifactServingEnabled({ NODE_ENV: "production" }), false);
});

test("artifact serving is disabled by default in development (explicit opt-in required)", () => {
  assert.equal(artifactServingEnabled({ NODE_ENV: "development" }), false);
});

test("artifact serving is disabled by default when NODE_ENV is unset", () => {
  assert.equal(artifactServingEnabled({}), false);
});

test("artifact serving requires explicit opt-in in production", () => {
  assert.equal(
    artifactServingEnabled({
      NODE_ENV: "production",
      PACKETAGENT_ARTIFACT_SERVING_ENABLED: "true",
    }),
    true,
  );
});

test("artifact serving requires explicit opt-in in development", () => {
  assert.equal(
    artifactServingEnabled({
      NODE_ENV: "development",
      PACKETAGENT_ARTIFACT_SERVING_ENABLED: "1",
    }),
    true,
  );
});

test("artifact serving stays off when explicitly disabled", () => {
  assert.equal(
    artifactServingEnabled({
      NODE_ENV: "development",
      PACKETAGENT_ARTIFACT_SERVING_ENABLED: "false",
    }),
    false,
  );
});

test("ordinary responses receive restrictive browser security headers", async () => {
  const response = await app.request("/api/health");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("permissions-policy") ?? "", /camera=(?:none|\(\))/);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /object-src 'none'/);
});

test("generated-app previews keep baseline headers without inheriting the workbench CSP", async () => {
  const response = await app.request("/api/app/generated-apps/missing/preview");

  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("permissions-policy") ?? "", /camera=(?:none|\(\))/);
  assert.equal(response.headers.get("content-security-policy"), null);
});

test("artifact ownership matches both canonical and legacy run records exactly", () => {
  const records = {
    agentRuns: [{ id: "agent-run", workspaceId: "alpha" }],
    workerRuns: [{ id: "worker-run", workspaceId: "beta" }],
  };

  assert.equal(artifactRunBelongsToWorkspace(records, "alpha", "agent-run"), true);
  assert.equal(artifactRunBelongsToWorkspace(records, "beta", "worker-run"), true);
  assert.equal(artifactRunBelongsToWorkspace(records, "beta", "agent-run"), false);
  assert.equal(artifactRunBelongsToWorkspace(records, "alpha", "agent"), false);
});

test(
  "enabled artifact serving requires an owning-workspace session",
  { concurrency: false },
  async () => {
    const previous = process.env.PACKETAGENT_ARTIFACT_SERVING_ENABLED;
    const runId = "run_alpha_support_latest";
    const fileName = "r1-artifact-authorization.txt";
    const directory = join(process.cwd(), "data", "artifacts", runId);
    const filePath = join(directory, fileName);

    try {
      process.env.PACKETAGENT_ARTIFACT_SERVING_ENABLED = "true";
      resetStoreForTests();
      const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
      const beta = login({ email: "beta@packetagent.local", password: "demo12345" });
      mkdirSync(directory, { recursive: true });
      writeFileSync(filePath, "workspace-scoped artifact", "utf8");

      const path = `/data/artifacts/${runId}/${fileName}`;
      const ownerResponse = await app.request(path, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${alpha.cookieValue}` },
      });
      assert.equal(ownerResponse.status, 200);
      assert.equal(await ownerResponse.text(), "workspace-scoped artifact");

      const otherWorkspaceResponse = await app.request(path, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${beta.cookieValue}` },
      });
      assert.equal(otherWorkspaceResponse.status, 404);

      const anonymousResponse = await app.request(path);
      assert.equal(anonymousResponse.status, 401);
    } finally {
      rmSync(filePath, { force: true });
      if (previous === undefined) delete process.env.PACKETAGENT_ARTIFACT_SERVING_ENABLED;
      else process.env.PACKETAGENT_ARTIFACT_SERVING_ENABLED = previous;
    }
  },
);
