import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeTool } from "../executor.js";
import { createShellForAgentTool } from "../shell-agent.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "packetagent-shell-agent-"));
}

function context(agentId = "agent-1") {
  return { workspaceId: "w", userId: "u", agentId };
}

test("rejects commands outside the default allowlist", async () => {
  const root = makeTempDir();
  try {
    const tool = createShellForAgentTool({
      projectRoot: root,
      artifactRoot: join(root, "artifacts"),
    });

    const record = await executeTool({
      tool,
      input: { command: "curl", args: ["https://example.com"] },
      context: context(),
    });

    assert.equal(record.status, "error");
    assert.match(record.error ?? "", /allowlist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires an agent id and defaults cwd to a per-agent artifact work directory", async () => {
  const root = makeTempDir();
  try {
    const artifactRoot = join(root, "artifacts");
    const contextArtifactRoot = join(root, "ctx-artifacts");
    const tool = createShellForAgentTool({ projectRoot: root, artifactRoot });

    const missingAgent = await executeTool({
      tool,
      input: { command: "pwd" },
      context: { workspaceId: "w", userId: "u" },
    });
    assert.equal(missingAgent.status, "error");
    assert.match(missingAgent.error ?? "", /agentId/);

    const record = await executeTool({
      tool,
      input: { command: "node", args: ["-e", "console.log(process.cwd())"] },
      context: { ...context("agent/path:one"), artifactDir: contextArtifactRoot },
    });

    assert.equal(record.status, "ok");
    const out = record.output as { cwd: string; stdout: string };
    assert.match(out.cwd, /ctx-artifacts/);
    assert.match(out.cwd, /agents/);
    assert.match(out.cwd, /work$/);
    assert.equal(resolve(out.stdout.trim()), out.cwd);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects cwd outside the scoped roots", async () => {
  const root = makeTempDir();
  const outside = makeTempDir();
  try {
    const tool = createShellForAgentTool({
      projectRoot: root,
      artifactRoot: join(root, "artifacts"),
    });

    const record = await executeTool({
      tool,
      input: { command: "pwd", cwd: outside },
      context: context(),
    });

    assert.equal(record.status, "error");
    assert.match(record.error ?? "", /cwd scope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("runs an allowed command without shell interpolation and captures output", async () => {
  const root = makeTempDir();
  try {
    const tool = createShellForAgentTool({
      projectRoot: root,
      artifactRoot: join(root, "artifacts"),
    });

    const record = await executeTool({
      tool,
      input: {
        command: "node",
        args: ["-e", "console.log(process.argv.slice(1).join('|'))", "hello; echo nope", "$HOME"],
        cwd: root,
      },
      context: context(),
    });

    assert.equal(record.status, "ok");
    const out = record.output as {
      exitCode: number;
      stdout: string;
      command: string;
      args: string[];
      killed: boolean;
    };
    assert.equal(out.exitCode, 0);
    assert.equal(out.command, "node");
    assert.deepEqual(out.args.slice(-2), ["hello; echo nope", "$HOME"]);
    assert.equal(out.stdout.trim(), "hello; echo nope|$HOME");
    assert.equal(out.killed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scrubs the environment to PATH and NODE_ENV", async () => {
  const root = makeTempDir();
  const previousSecret = process.env.PACKETAGENT_SECRET_SHOULD_NOT_LEAK;
  process.env.PACKETAGENT_SECRET_SHOULD_NOT_LEAK = "secret";
  try {
    const envProbeScript = [
      "console.log(JSON.stringify({",
      "home:Object.hasOwn(process.env,'HOME'),",
      "secret:Object.hasOwn(process.env,'PACKETAGENT_SECRET_SHOULD_NOT_LEAK'),",
      "path:Object.hasOwn(process.env,'PATH'),",
      "nodeEnv:Object.hasOwn(process.env,'NODE_ENV')",
      "}))",
    ].join("");
    const tool = createShellForAgentTool({
      projectRoot: root,
      artifactRoot: join(root, "artifacts"),
    });

    const record = await executeTool({
      tool,
      input: {
        command: "node",
        args: ["-e", envProbeScript],
      },
      context: context(),
    });

    assert.equal(record.status, "ok");
    const out = record.output as { stdout: string };
    assert.deepEqual(JSON.parse(out.stdout), {
      home: false,
      secret: false,
      path: true,
      nodeEnv: true,
    });
  } finally {
    if (previousSecret === undefined) delete process.env.PACKETAGENT_SECRET_SHOULD_NOT_LEAK;
    else process.env.PACKETAGENT_SECRET_SHOULD_NOT_LEAK = previousSecret;
    rmSync(root, { recursive: true, force: true });
  }
});

test("kills a long-running command via timeout", async () => {
  const root = makeTempDir();
  try {
    const tool = createShellForAgentTool({
      projectRoot: root,
      artifactRoot: join(root, "artifacts"),
      defaultTimeoutMs: 200,
      maxTimeoutMs: 1_000,
    });

    const record = await executeTool({
      tool,
      input: { command: "node", args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 100 },
      context: context(),
    });

    assert.equal(record.status, "error");
    assert.match(record.error ?? "", /timeout/);
    const out = record.output as {
      killed: boolean;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    };
    assert.equal(out.killed, true);
    assert.equal(out.exitCode, null);
    assert.ok(out.signal === "SIGTERM" || out.signal === "SIGKILL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kills a long-running command when the tool context is aborted", async () => {
  const root = makeTempDir();
  try {
    const tool = createShellForAgentTool({
      projectRoot: root,
      artifactRoot: join(root, "artifacts"),
      maxTimeoutMs: 2_000,
    });
    const ctrl = new AbortController();

    const promise = executeTool({
      tool,
      input: { command: "node", args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 1_000 },
      context: { ...context(), signal: ctrl.signal },
    });
    setTimeout(() => ctrl.abort(), 50);
    const record = await promise;

    assert.equal(record.status, "error");
    assert.match(record.error ?? "", /canceled/);
    const out = record.output as { killed: boolean };
    assert.equal(out.killed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
