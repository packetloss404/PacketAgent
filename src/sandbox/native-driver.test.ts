import assert from "node:assert/strict";
import test from "node:test";
import { createNativeDriver } from "./native-driver.js";

test("native driver runs `echo hello` and reports exit 0 with stdout", async () => {
  const driver = createNativeDriver();
  const handle = await driver.start({
    execId: "t1",
    runtime: "host",
    command: "echo hello",
    workingDir: process.cwd(),
    timeoutMs: 5_000,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const exit = await new Promise<{ exitCode: number | null; errorMessage?: string }>((resolve) => {
    driver.subscribe(
      handle,
      (chunk) => {
        if (chunk.stream === "stdout") stdoutChunks.push(chunk.data);
        else stderrChunks.push(chunk.data);
      },
      (event) => {
        const out: { exitCode: number | null; errorMessage?: string } = {
          exitCode: event.exitCode,
        };
        if (event.errorMessage) out.errorMessage = event.errorMessage;
        resolve(out);
      },
    );
  });

  await handle.done;

  assert.equal(exit.exitCode, 0);
  assert.equal(exit.errorMessage, undefined);
  // Different shells/quoting on Windows can yield "hello\r\n", "hello\n", or
  // surrounding quotes depending on how the shell echoes the literal. Just
  // assert that the literal "hello" appears somewhere on stdout.
  const stdout = stdoutChunks.join("");
  assert.ok(
    stdout.includes("hello"),
    `expected stdout to contain "hello", got ${JSON.stringify(stdout)}`,
  );
  assert.equal(stderrChunks.join(""), "");
});

test("native driver kill on cancel terminates the child", async () => {
  const driver = createNativeDriver();
  // A cross-platform long-running command: node sleeping
  const handle = await driver.start({
    execId: "t2",
    runtime: "host",
    command: `node -e "setTimeout(() => process.exit(0), 60000)"`,
    workingDir: process.cwd(),
    timeoutMs: 60_000,
  });

  const exitPromise = new Promise<{
    exitCode: number | null;
    errorMessage?: string;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    driver.subscribe(
      handle,
      () => {},
      (event) =>
        resolve({
          exitCode: event.exitCode,
          signal: event.signal ?? null,
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        }),
    );
  });

  // Give the child a moment to register
  await new Promise((resolve) => setTimeout(resolve, 50));
  await driver.cancel(handle);
  const exit = await exitPromise;
  await handle.done;

  // After SIGKILL the exit code is null and signal is set on POSIX, or exitCode
  // is non-zero on Windows. Either way it must NOT be a clean 0.
  assert.notEqual(exit.exitCode, 0);
});
