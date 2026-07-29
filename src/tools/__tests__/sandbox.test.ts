import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxedShellTool } from "../sandbox.js";
import { executeTool } from "../executor.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "packetagent-sandbox-"));
}

test("rejects commands not on the allowlist", async () => {
  const tool = createSandboxedShellTool({ allowedCommands: ["echo"] });
  const record = await executeTool({
    tool,
    input: { command: "rm", args: ["-rf", "/"] },
    context: { workspaceId: "w", userId: "u" },
  });
  assert.equal(record.status, "error");
  assert.match(record.error ?? "", /not in the sandbox allowlist/);
});

test("rejects cwd outside allowlist", async () => {
  const tool = createSandboxedShellTool({
    allowedCommands: ["echo"],
    cwdAllowlist: [process.cwd()],
  });
  const record = await executeTool({
    tool,
    input: { command: "echo", args: ["hi"], cwd: "/etc" },
    context: { workspaceId: "w", userId: "u" },
  });
  assert.equal(record.status, "error");
  assert.match(record.error ?? "", /not inside the sandbox allowlist/);
});

test("runs an allowed command and captures stdout", async () => {
  const dir = makeTempDir();
  try {
    const tool = createSandboxedShellTool({
      allowedCommands: process.platform === "win32" ? ["cmd"] : ["echo"],
      cwdAllowlist: [dir],
    });
    const isWin = process.platform === "win32";
    const record = await executeTool({
      tool,
      input: isWin
        ? { command: "cmd", args: ["/c", "echo", "hello"], cwd: dir }
        : { command: "echo", args: ["hello"], cwd: dir },
      context: { workspaceId: "w", userId: "u" },
    });
    assert.equal(record.status, "ok");
    const out = record.output as { stdout: string; exitCode: number };
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kills a long-running command via timeout", async () => {
  const dir = makeTempDir();
  try {
    const cmd = process.platform === "win32" ? "cmd" : "node";
    const args =
      process.platform === "win32"
        ? ["/c", "ping", "-n", "10", "127.0.0.1"]
        : ["-e", "setInterval(()=>{},1000)"];
    const tool = createSandboxedShellTool({
      allowedCommands: [cmd],
      cwdAllowlist: [dir],
      timeoutMs: 200,
    });
    const record = await executeTool({
      tool,
      input: { command: cmd, args, cwd: dir },
      context: { workspaceId: "w", userId: "u" },
    });
    assert.equal(record.status, "error");
    const out = record.output as { killed: boolean } | undefined;
    if (out) assert.equal(out.killed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
