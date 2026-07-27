import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runValidatorCli, validateAccessLogContent } from "./proxy-access-log-validator";

test("empty content returns zero violations", () => {
  const result = validateAccessLogContent("");
  assert.equal(result.violations.length, 0);
});

test("clean JSON log line returns zero violations", () => {
  const line = '{"ts":"2026-04-26T00:00:00Z","method":"GET","status":200,"path":"/api/health"}';
  const result = validateAccessLogContent(line);
  assert.equal(result.violations.length, 0);
});

test("raw bearer token flags as a violation", () => {
  const result = validateAccessLogContent("GET / HTTP/1.1 Authorization: Bearer abc123");
  assert.ok(result.violations.length >= 1);
  const bearer = result.violations.find((v) => v.pattern === "bearer-token");
  assert.ok(bearer);
  assert.ok(bearer.snippet.toLowerCase().includes("bearer"));
});

test("share path with raw token flags", () => {
  const result = validateAccessLogContent("GET /share/raw-token-abc HTTP/1.1");
  const share = result.violations.find((v) => v.pattern === "share-path");
  assert.ok(share);
  assert.ok(share.snippet.includes("raw-token-abc"));
});

test("public webhook path with whk token flags", () => {
  const result = validateAccessLogContent("POST /api/public/webhooks/agents/whk_secret_value HTTP/1.1");
  const webhook = result.violations.find((v) => v.pattern === "public-webhook-path");
  assert.ok(webhook);
  assert.ok(webhook.snippet.includes("whk_"));
  const tokenViolation = result.violations.find((v) => v.pattern === "webhook-token");
  assert.ok(tokenViolation);
});

test("invitation accept path flags", () => {
  const result = validateAccessLogContent("POST /api/app/invitations/inv_raw_token_value/accept HTTP/1.1");
  const invitation = result.violations.find((v) => v.pattern === "invitation-accept-path");
  assert.ok(invitation);
  assert.ok(invitation.snippet.includes("inv_raw_token_value"));
});

test("query param with raw token flags", () => {
  const result = validateAccessLogContent("GET /thing?token=raw_secret_value HTTP/1.1");
  const query = result.violations.find((v) => v.pattern === "sensitive-query-param");
  assert.ok(query);
  assert.ok(query.snippet.includes("raw_secret_value"));
});

test("query param already redacted does not flag", () => {
  const result = validateAccessLogContent("GET /thing?token=[redacted] HTTP/1.1");
  const query = result.violations.find((v) => v.pattern === "sensitive-query-param");
  assert.equal(query, undefined);
});

test("authorization bearer redacted does not flag", () => {
  const result = validateAccessLogContent("Authorization: Bearer [redacted]");
  const bearer = result.violations.find((v) => v.pattern === "bearer-token");
  assert.equal(bearer, undefined);
});

test("multi-line content reports correct 1-indexed line numbers", () => {
  const content = [
    '{"ts":"2026-04-26T00:00:00Z","method":"GET","status":200,"path":"/api/health"}',
    "GET /api/public/share/raw-share-token HTTP/1.1",
    "GET /clean HTTP/1.1",
    "GET /thing?secret=value-here HTTP/1.1",
  ].join("\n");
  const { violations } = validateAccessLogContent(content);
  const share = violations.find((v) => v.pattern === "public-share-path");
  const query = violations.find((v) => v.pattern === "sensitive-query-param");
  assert.ok(share);
  assert.equal(share.line, 2);
  assert.ok(query);
  assert.equal(query.line, 4);
});

test("each violation has a non-empty pattern and a snippet within 80 chars", () => {
  const longLine = `GET /share/${"a".repeat(200)} HTTP/1.1`;
  const { violations } = validateAccessLogContent(longLine);
  assert.ok(violations.length >= 1);
  for (const violation of violations) {
    assert.ok(violation.pattern.length > 0);
    assert.ok(violation.snippet.length > 0);
    assert.ok(violation.snippet.length <= 80);
  }
});

test("runValidatorCli returns 0 for a clean file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-validator-"));
  const file = join(dir, "clean.log");
  writeFileSync(file, '{"ts":"2026-04-26T00:00:00Z","method":"GET","status":200,"path":"/api/health"}\n');
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await runValidatorCli([file]);
    assert.equal(code, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runValidatorCli returns 1 for a file with violations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-validator-"));
  const file = join(dir, "dirty.log");
  writeFileSync(file, "GET /share/raw-token-abc HTTP/1.1\n");
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await runValidatorCli([file]);
    assert.equal(code, 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runValidatorCli returns 2 with no args", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const code = await runValidatorCli([]);
    assert.equal(code, 2);
  } finally {
    console.error = originalError;
  }
});

test("runValidatorCli returns 2 when file does not exist", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const code = await runValidatorCli([join(tmpdir(), "definitely-not-a-real-file-xyz.log")]);
    assert.equal(code, 2);
  } finally {
    console.error = originalError;
  }
});
