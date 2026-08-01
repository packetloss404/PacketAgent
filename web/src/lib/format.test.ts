import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBytes,
  formatDuration,
  formatMoney,
  formatRelativeTime,
  formatStatusLabel,
  shortDigest,
} from "./format.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

test("shared relative-time formatting preserves Builder and operations copy", () => {
  assert.equal(
    formatRelativeTime("2026-08-01T11:59:45.000Z", { now: NOW, underMinute: "just-now" }),
    "just now",
  );
  assert.equal(formatRelativeTime("2026-08-01T11:59:45.000Z", { now: NOW }), "15s ago");
  assert.equal(formatRelativeTime("2026-08-01T10:00:00.000Z", { now: NOW }), "2h ago");
  assert.equal(formatRelativeTime("invalid", { now: NOW }), "invalid");
  assert.equal(formatRelativeTime(null, { now: NOW }), "—");
});

test("shared value formatters preserve Worker budget, artifact, and identifier output", () => {
  assert.equal(formatDuration(950, { allowZero: true, includeMinutes: true }), "950ms");
  assert.equal(formatDuration(90_000, { allowZero: true, includeMinutes: true }), "1.5m");
  assert.equal(formatMoney(0.009), "$0.009");
  assert.equal(formatMoney(12), "$12.00");
  assert.equal(formatBytes(1_536), "1.5 KB");
  assert.equal(shortDigest("sha256:123456789012345678901234567890"), "sha256:1234567890123…");
  assert.equal(formatStatusLabel("waiting_for_approval"), "waiting for approval");
});
