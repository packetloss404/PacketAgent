import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { verifyGeneratedAppReachability } from "./generated-app-publish-reachability";

const appId = "gapp_reachability";
const checkpointId = "checkpoint_reachability";

test("generated app reachability verifies transport, health, identity, and HTML", async () => {
  const fixture = publishFixture();
  const server = await startFixtureServer((path) => {
    if (path === "/health/live") return json(200, { status: "live" });
    if (path === "/health/ready")
      return json(200, {
        status: "ready",
        appId,
        checkpointId,
        schemaChangePolicy: "reset-and-reseed",
      });
    return html(200, "<!doctype html><title>Reachable generated app</title>");
  });
  try {
    const result = await verifyGeneratedAppReachability(fixture, server.origin);

    assert.equal(result.status, "pass");
    assert.equal(result.origin, server.origin);
    assert.deepEqual(
      result.steps.map((step) => [step.id, step.status]),
      [
        ["url", "pass"],
        ["dns", "pass"],
        ["transport", "pass"],
        ["liveness", "pass"],
        ["readiness", "pass"],
        ["app-root", "pass"],
      ],
    );
    assert.match(
      result.steps.find((step) => step.id === "readiness")?.detail ?? "",
      new RegExp(`${appId} checkpoint ${checkpointId}`),
    );
  } finally {
    await closeServer(server.server);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("generated app reachability fails closed on identity substitution", async () => {
  const fixture = publishFixture();
  const server = await startFixtureServer((path) => {
    if (path === "/health/live") return json(200, { status: "live" });
    if (path === "/health/ready")
      return json(200, {
        status: "ready",
        appId: "gapp_other",
        checkpointId: "checkpoint_other",
        schemaChangePolicy: "reset-and-reseed",
      });
    return html(200, "<!doctype html>");
  });
  try {
    const result = await verifyGeneratedAppReachability(fixture, server.origin);

    assert.equal(result.status, "fail");
    assert.equal(result.steps.at(-1)?.id, "readiness");
    assert.equal(result.steps.at(-1)?.code, "identity_mismatch");
    assert.equal(
      result.steps.some((step) => step.id === "app-root"),
      false,
    );
  } finally {
    await closeServer(server.server);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("generated app reachability refuses redirects instead of following another origin", async () => {
  const fixture = publishFixture();
  const server = await startFixtureServer((path) => {
    if (path === "/health/live")
      return {
        status: 302,
        headers: { location: "https://unrelated.example.test/health/live" },
        body: "",
      };
    return json(200, {
      status: "ready",
      appId,
      checkpointId,
      schemaChangePolicy: "reset-and-reseed",
    });
  });
  try {
    const result = await verifyGeneratedAppReachability(fixture, server.origin);

    assert.equal(result.status, "fail");
    assert.equal(result.steps.at(-1)?.id, "liveness");
    assert.equal(result.steps.at(-1)?.code, "unexpected_redirect");
  } finally {
    await closeServer(server.server);
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("generated app reachability requires HTTPS away from loopback", async () => {
  const fixture = publishFixture();
  try {
    const result = await verifyGeneratedAppReachability(fixture, "http://app.example.test");

    assert.equal(result.status, "fail");
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]?.id, "url");
    assert.equal(result.steps[0]?.code, "insecure_public_url");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("generated app reachability fails closed when schema-change policy is obscured", async () => {
  const fixture = publishFixture();
  const server = await startFixtureServer((path) => {
    if (path === "/health/live") return json(200, { status: "live" });
    if (path === "/health/ready") {
      return json(200, {
        status: "ready",
        appId,
        checkpointId,
        schemaChangePolicy: "automatic-migration",
      });
    }
    return html(200, "<!doctype html>");
  });
  try {
    const result = await verifyGeneratedAppReachability(fixture, server.origin);

    assert.equal(result.status, "fail");
    assert.equal(result.steps.at(-1)?.id, "readiness");
    assert.equal(result.steps.at(-1)?.code, "policy_mismatch");
  } finally {
    await closeServer(server.server);
    rmSync(fixture, { recursive: true, force: true });
  }
});

function publishFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "packetagent-reachability-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "runtime-config.json"),
    `${JSON.stringify({
      runtime: "packetagent-generated-app-standalone",
      workspaceId: "workspace_reachability",
      appId,
      checkpointId,
      schemaChangePolicy: "reset-and-reseed",
    })}\n`,
  );
  return root;
}

async function startFixtureServer(
  responder: (path: string) => FixtureResponse,
): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const fixture = responder(new URL(request.url || "/", "http://localhost").pathname);
    response.writeHead(fixture.status, fixture.headers);
    response.end(fixture.body);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no TCP port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function json(status: number, value: unknown): FixtureResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: `${JSON.stringify(value)}\n`,
  };
}

function html(status: number, body: string): FixtureResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8" }, body };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
}

interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
