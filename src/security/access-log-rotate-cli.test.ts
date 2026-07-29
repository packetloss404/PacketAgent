import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAccessLogRotateCli } from "./access-log-rotate-cli.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "access-log-rotate-cli-"));
}

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: {
      out: (line: string) => {
        out.push(line);
      },
      err: (line: string) => {
        err.push(line);
      },
    },
  };
}

test("returns 2 with a useful err message when neither --path nor env path is set", async () => {
  const io = makeIo();
  const code = await runAccessLogRotateCli({
    argv: [],
    env: {},
    out: io.write.out,
    err: io.write.err,
  });
  assert.equal(code, 2);
  assert.equal(io.out.length, 0);
  assert.equal(io.err.length, 1);
  assert.match(
    io.err[0],
    /access-log:rotate requires --path=<file> or PACKETAGENT_ACCESS_LOG_PATH/,
  );
});

test("returns 0 with rotated:false when the configured path does not exist", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "missing.log");
    const io = makeIo();
    const code = await runAccessLogRotateCli({
      argv: [`--path=${target}`],
      env: {},
      out: io.write.out,
      err: io.write.err,
    });
    assert.equal(code, 0);
    assert.equal(io.err.length, 0);
    assert.equal(io.out.length, 1);
    const parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.command, "access-log:rotate");
    assert.equal(parsed.rotated, false);
    assert.equal(parsed.from, target);
    assert.equal(parsed.to, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns 0 with rotated:true and renames file to <path>.1 when the file exists", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "access.log");
    writeFileSync(target, "line1\n");
    const io = makeIo();
    const code = await runAccessLogRotateCli({
      argv: [`--path=${target}`],
      env: {},
      out: io.write.out,
      err: io.write.err,
    });
    assert.equal(code, 0);
    assert.equal(io.err.length, 0);
    const parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.command, "access-log:rotate");
    assert.equal(parsed.rotated, true);
    assert.equal(parsed.from, target);
    assert.equal(parsed.to, `${target}.1`);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(`${target}.1`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--max-files=<n> argv overrides env value and applies to multiple rotations", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "access.log");

    writeFileSync(target, "first\n");
    let io = makeIo();
    let code = await runAccessLogRotateCli({
      argv: [`--path=${target}`, "--max-files=2"],
      env: { PACKETAGENT_ACCESS_LOG_MAX_FILES: "10" },
      out: io.write.out,
      err: io.write.err,
    });
    assert.equal(code, 0);
    let parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.maxFiles, 2);
    assert.equal(parsed.rotated, true);
    assert.equal(existsSync(`${target}.1`), true);

    writeFileSync(target, "second\n");
    io = makeIo();
    code = await runAccessLogRotateCli({
      argv: [`--path=${target}`, "--max-files=2"],
      env: { PACKETAGENT_ACCESS_LOG_MAX_FILES: "10" },
      out: io.write.out,
      err: io.write.err,
    });
    assert.equal(code, 0);
    parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.maxFiles, 2);
    assert.equal(parsed.rotated, true);
    assert.equal(existsSync(`${target}.1`), true);
    assert.equal(existsSync(`${target}.2`), true);

    writeFileSync(target, "third\n");
    io = makeIo();
    code = await runAccessLogRotateCli({
      argv: [`--path=${target}`, "--max-files=2"],
      env: {},
      out: io.write.out,
      err: io.write.err,
    });
    assert.equal(code, 0);
    parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.maxFiles, 2);
    assert.equal(parsed.rotated, true);
    assert.equal(existsSync(`${target}.1`), true);
    assert.equal(existsSync(`${target}.2`), true);
    assert.equal(existsSync(`${target}.3`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PACKETAGENT_ACCESS_LOG_PATH env value is honored when --path not given", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "from-env.log");
    writeFileSync(target, "env-driven\n");
    const io = makeIo();
    const code = await runAccessLogRotateCli({
      argv: [],
      env: { PACKETAGENT_ACCESS_LOG_PATH: target },
      out: io.write.out,
      err: io.write.err,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.command, "access-log:rotate");
    assert.equal(parsed.rotated, true);
    assert.equal(parsed.from, target);
    assert.equal(parsed.to, `${target}.1`);
    assert.equal(parsed.maxFiles, 5);
    assert.equal(existsSync(`${target}.1`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output line is valid JSON containing command, path, maxFiles, rotated, from, to fields", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "shape.log");
    writeFileSync(target, "shape\n");
    const io = makeIo();
    const code = await runAccessLogRotateCli({
      argv: [`--path=${target}`, "--max-files=3"],
      env: {},
      out: io.write.out,
      err: io.write.err,
    });
    assert.equal(code, 0);
    assert.equal(io.out.length, 1);
    const parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.command, "access-log:rotate");
    assert.equal(parsed.path, target);
    assert.equal(parsed.maxFiles, 3);
    assert.equal(typeof parsed.rotated, "boolean");
    assert.equal(parsed.from, target);
    assert.equal(parsed.to, `${target}.1`);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, "to"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to PACKETAGENT_ACCESS_LOG_MAX_FILES env when argv flag absent", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "env-max.log");
    writeFileSync(target, "x\n");
    const io = makeIo();
    const code = await runAccessLogRotateCli({
      argv: [`--path=${target}`],
      env: { PACKETAGENT_ACCESS_LOG_MAX_FILES: "7" },
      out: io.write.out,
      err: io.write.err,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.maxFiles, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores invalid argv max-files and falls through to env default", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "invalid-max.log");
    writeFileSync(target, "y\n");
    const io = makeIo();
    const code = await runAccessLogRotateCli({
      argv: [`--path=${target}`, "--max-files=0"],
      env: { PACKETAGENT_ACCESS_LOG_MAX_FILES: "4" },
      out: io.write.out,
      err: io.write.err,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(io.out[0]);
    assert.equal(parsed.maxFiles, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
