import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import {
  __resetAccessLogForTests,
  accessLogMiddleware,
  formatAccessLogLine,
  rotateAccessLogFile,
} from "./access-log.js";

const FIXED_NOW = new Date("2026-04-26T12:00:00.000Z");

function baseInput(overrides: Partial<Parameters<typeof formatAccessLogLine>[0]> = {}) {
  return {
    method: "GET",
    status: 200,
    path: "/",
    query: null,
    durationMs: 12,
    userId: null,
    workspaceId: null,
    requestId: null,
    now: FIXED_NOW,
    ...overrides,
  };
}

test("formatAccessLogLine redacts whk_ webhook tokens in path", () => {
  const line = formatAccessLogLine(
    baseInput({
      path: "/api/public/webhooks/agents/whk_some_secret_token",
    }),
  );
  const parsed = JSON.parse(line);
  assert.equal(parsed.path.includes("whk_some_secret_token"), false);
  assert.equal(parsed.path.startsWith("/api/public/webhooks/agents/[redacted]"), true);
});

test("formatAccessLogLine redacts /share/<token> path", () => {
  const line = formatAccessLogLine(
    baseInput({
      path: "/share/share-token-1234",
    }),
  );
  const parsed = JSON.parse(line);
  assert.equal(parsed.path.includes("share-token-1234"), false);
  assert.equal(parsed.path.startsWith("/share/[redacted]"), true);
});

test("formatAccessLogLine redacts /api/app/invitations/<token>/accept", () => {
  const line = formatAccessLogLine(
    baseInput({
      path: "/api/app/invitations/invite-secret-1234/accept",
    }),
  );
  const parsed = JSON.parse(line);
  assert.equal(parsed.path.includes("invite-secret-1234"), false);
  assert.equal(parsed.path.includes("[redacted]"), true);
  assert.equal(parsed.path.endsWith("/accept"), true);
});

test("formatAccessLogLine redacts token and access_token query params", () => {
  const line = formatAccessLogLine(
    baseInput({
      path: "/api/things",
      query: "token=secret&access_token=other",
    }),
  );
  const parsed = JSON.parse(line);
  assert.equal(parsed.path.includes("secret"), false);
  assert.equal(parsed.path.includes("other"), false);
  assert.equal(parsed.path.includes("[redacted]"), true);
});

test("formatAccessLogLine keeps method, status, durationMs, userId, workspaceId verbatim", () => {
  const line = formatAccessLogLine(
    baseInput({
      method: "POST",
      status: 201,
      path: "/api/app/agents",
      durationMs: 42,
      userId: "user-abc",
      workspaceId: "ws-xyz",
      requestId: "req-1",
    }),
  );
  const parsed = JSON.parse(line);
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.status, 201);
  assert.equal(parsed.durationMs, 42);
  assert.equal(parsed.userId, "user-abc");
  assert.equal(parsed.workspaceId, "ws-xyz");
  assert.equal(parsed.requestId, "req-1");
  assert.equal(parsed.ts, FIXED_NOW.toISOString());
  assert.equal(line.endsWith("\n"), true);
});

test("middleware in 'off' mode does not write to stdout", async () => {
  const previousMode = process.env.PACKETAGENT_ACCESS_LOG_MODE;
  process.env.PACKETAGENT_ACCESS_LOG_MODE = "off";
  __resetAccessLogForTests();
  const captured: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = ((
    chunk: unknown,
  ) => {
    captured.push(String(chunk));
    return true;
  }) as never;
  try {
    const app = new Hono();
    app.use("*", accessLogMiddleware());
    app.get("/ping", (c) => c.json({ ok: true }));
    const res = await app.request("/ping");
    assert.equal(res.status, 200);
    assert.equal(captured.length, 0);
  } finally {
    (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
    if (previousMode === undefined) delete process.env.PACKETAGENT_ACCESS_LOG_MODE;
    else process.env.PACKETAGENT_ACCESS_LOG_MODE = previousMode;
    __resetAccessLogForTests();
  }
});

function makeTmpDir(label: string): string {
  const dir = join(
    tmpdir(),
    `packetagent-access-log-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withFileEnv(
  filePath: string,
  maxBytes: string | null,
  maxFiles: string | null,
): () => void {
  const previous = {
    mode: process.env.PACKETAGENT_ACCESS_LOG_MODE,
    path: process.env.PACKETAGENT_ACCESS_LOG_PATH,
    maxBytes: process.env.PACKETAGENT_ACCESS_LOG_MAX_BYTES,
    maxFiles: process.env.PACKETAGENT_ACCESS_LOG_MAX_FILES,
  };
  process.env.PACKETAGENT_ACCESS_LOG_MODE = "file";
  process.env.PACKETAGENT_ACCESS_LOG_PATH = filePath;
  if (maxBytes === null) delete process.env.PACKETAGENT_ACCESS_LOG_MAX_BYTES;
  else process.env.PACKETAGENT_ACCESS_LOG_MAX_BYTES = maxBytes;
  if (maxFiles === null) delete process.env.PACKETAGENT_ACCESS_LOG_MAX_FILES;
  else process.env.PACKETAGENT_ACCESS_LOG_MAX_FILES = maxFiles;
  __resetAccessLogForTests();
  return () => {
    if (previous.mode === undefined) delete process.env.PACKETAGENT_ACCESS_LOG_MODE;
    else process.env.PACKETAGENT_ACCESS_LOG_MODE = previous.mode;
    if (previous.path === undefined) delete process.env.PACKETAGENT_ACCESS_LOG_PATH;
    else process.env.PACKETAGENT_ACCESS_LOG_PATH = previous.path;
    if (previous.maxBytes === undefined) delete process.env.PACKETAGENT_ACCESS_LOG_MAX_BYTES;
    else process.env.PACKETAGENT_ACCESS_LOG_MAX_BYTES = previous.maxBytes;
    if (previous.maxFiles === undefined) delete process.env.PACKETAGENT_ACCESS_LOG_MAX_FILES;
    else process.env.PACKETAGENT_ACCESS_LOG_MAX_FILES = previous.maxFiles;
    __resetAccessLogForTests();
  };
}

async function waitForFile(filePath: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(filePath)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("rotateAccessLogFile returns rotated:false when source path does not exist", () => {
  const dir = makeTmpDir("rotate-missing");
  try {
    const filePath = join(dir, "access.log");
    const result = rotateAccessLogFile(filePath, 5);
    assert.equal(result.rotated, false);
    assert.equal(result.from, filePath);
    assert.equal(result.to, null);
    assert.equal(existsSync(filePath), false);
    assert.equal(existsSync(`${filePath}.1`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateAccessLogFile renames a single existing file to .1", () => {
  const dir = makeTmpDir("rotate-single");
  try {
    const filePath = join(dir, "access.log");
    writeFileSync(filePath, "hello\n");
    const result = rotateAccessLogFile(filePath, 5);
    assert.equal(result.rotated, true);
    assert.equal(result.from, filePath);
    assert.equal(result.to, `${filePath}.1`);
    assert.equal(existsSync(filePath), false);
    assert.equal(existsSync(`${filePath}.1`), true);
    assert.equal(readFileSync(`${filePath}.1`, "utf8"), "hello\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateAccessLogFile shifts existing rotations and drops the oldest beyond maxFiles", () => {
  const dir = makeTmpDir("rotate-shift");
  try {
    const filePath = join(dir, "access.log");
    writeFileSync(filePath, "current\n");
    writeFileSync(`${filePath}.1`, "rotated-1\n");
    writeFileSync(`${filePath}.2`, "rotated-2\n");
    const result = rotateAccessLogFile(filePath, 3);
    assert.equal(result.rotated, true);
    assert.equal(result.to, `${filePath}.1`);
    assert.equal(existsSync(filePath), false);
    assert.equal(readFileSync(`${filePath}.1`, "utf8"), "current\n");
    assert.equal(readFileSync(`${filePath}.2`, "utf8"), "rotated-1\n");
    assert.equal(readFileSync(`${filePath}.3`, "utf8"), "rotated-2\n");
    assert.equal(existsSync(`${filePath}.4`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateAccessLogFile overwrites the file at maxFiles when shifting", () => {
  const dir = makeTmpDir("rotate-overwrite");
  try {
    const filePath = join(dir, "access.log");
    writeFileSync(filePath, "current\n");
    writeFileSync(`${filePath}.1`, "rotated-1\n");
    writeFileSync(`${filePath}.2`, "rotated-2\n");
    writeFileSync(`${filePath}.3`, "should-be-dropped\n");
    const result = rotateAccessLogFile(filePath, 3);
    assert.equal(result.rotated, true);
    assert.equal(readFileSync(`${filePath}.1`, "utf8"), "current\n");
    assert.equal(readFileSync(`${filePath}.2`, "utf8"), "rotated-1\n");
    assert.equal(readFileSync(`${filePath}.3`, "utf8"), "rotated-2\n");
    assert.equal(existsSync(`${filePath}.4`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("middleware in file mode rotates when MAX_BYTES is exceeded", async () => {
  const dir = makeTmpDir("mw-rotate");
  const filePath = join(dir, "access.log");
  const restore = withFileEnv(filePath, "300", "5");
  try {
    const app = new Hono();
    app.use("*", accessLogMiddleware());
    app.get("/ping", (c) => c.json({ ok: true }));
    for (let i = 0; i < 12; i += 1) {
      const res = await app.request("/ping");
      assert.equal(res.status, 200);
    }
    __resetAccessLogForTests();
    await waitForFile(`${filePath}.1`);
    assert.equal(existsSync(`${filePath}.1`), true);
    if (existsSync(filePath)) {
      assert.ok(
        statSync(filePath).size <= 300,
        `current file size ${statSync(filePath).size} should be <= 300`,
      );
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("middleware does not rotate when MAX_BYTES is 0", async () => {
  const dir = makeTmpDir("mw-no-rotate");
  const filePath = join(dir, "access.log");
  const restore = withFileEnv(filePath, "0", "5");
  try {
    const app = new Hono();
    app.use("*", accessLogMiddleware());
    app.get("/ping", (c) => c.json({ ok: true }));
    for (let i = 0; i < 50; i += 1) {
      const res = await app.request("/ping");
      assert.equal(res.status, 200);
    }
    __resetAccessLogForTests();
    await waitForFile(filePath);
    assert.equal(existsSync(filePath), true);
    assert.equal(existsSync(`${filePath}.1`), false);
    assert.ok(statSync(filePath).size > 0);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("middleware honors MAX_FILES cap across many rotations", async () => {
  const dir = makeTmpDir("mw-maxfiles");
  const filePath = join(dir, "access.log");
  const restore = withFileEnv(filePath, "200", "2");
  try {
    const app = new Hono();
    app.use("*", accessLogMiddleware());
    app.get("/ping", (c) => c.json({ ok: true }));
    for (let i = 0; i < 60; i += 1) {
      const res = await app.request("/ping");
      assert.equal(res.status, 200);
    }
    __resetAccessLogForTests();
    await waitForFile(`${filePath}.1`);
    assert.equal(existsSync(`${filePath}.1`), true);
    assert.equal(existsSync(`${filePath}.3`), false);
    assert.equal(existsSync(`${filePath}.4`), false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("middleware in 'stdout' mode writes one redacted line per request", async () => {
  const previousMode = process.env.PACKETAGENT_ACCESS_LOG_MODE;
  process.env.PACKETAGENT_ACCESS_LOG_MODE = "stdout";
  __resetAccessLogForTests();
  const captured: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = ((
    chunk: unknown,
  ) => {
    captured.push(String(chunk));
    return true;
  }) as never;
  try {
    const app = new Hono();
    app.use("*", accessLogMiddleware());
    app.get("/api/public/webhooks/agents/:token", (c) => c.json({ ok: true }));
    const res = await app.request("/api/public/webhooks/agents/whk_super_secret?token=abc");
    assert.equal(res.status, 200);
    assert.equal(captured.length, 1);
    const line = captured[0];
    assert.equal(line.endsWith("\n"), true);
    const parsed = JSON.parse(line);
    assert.equal(parsed.method, "GET");
    assert.equal(parsed.status, 200);
    assert.equal(parsed.path.includes("whk_super_secret"), false);
    assert.equal(parsed.path.includes("abc"), false);
    assert.equal(typeof parsed.durationMs, "number");
  } finally {
    (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
    if (previousMode === undefined) delete process.env.PACKETAGENT_ACCESS_LOG_MODE;
    else process.env.PACKETAGENT_ACCESS_LOG_MODE = previousMode;
    __resetAccessLogForTests();
  }
});
