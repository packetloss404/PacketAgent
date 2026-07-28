import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, nextAfter, nextAfterInTimezone, parseCron } from "../cron.js";

test("parses */5 * * * * to fire on minutes divisible by 5", () => {
  const expr = parseCron("*/5 * * * *");
  assert.equal(matches(expr, new Date(2026, 0, 1, 12, 0)), true);
  assert.equal(matches(expr, new Date(2026, 0, 1, 12, 5)), true);
  assert.equal(matches(expr, new Date(2026, 0, 1, 12, 7)), false);
});

test("parses 0 9 * * 1-5 (weekday 9am)", () => {
  const expr = parseCron("0 9 * * 1-5");
  // 2026-01-05 is a Monday
  assert.equal(matches(expr, new Date(2026, 0, 5, 9, 0)), true);
  // Saturday
  assert.equal(matches(expr, new Date(2026, 0, 3, 9, 0)), false);
  // 8:59 Mon
  assert.equal(matches(expr, new Date(2026, 0, 5, 8, 59)), false);
});

test("invalid expression throws", () => {
  assert.throws(() => parseCron("nope"));
  assert.throws(() => parseCron("60 * * * *"));
  assert.throws(() => parseCron("0 9 * * 5-1"));
  assert.throws(() => parseCron("* * * *"));
});

test("accepts 7 as Sunday in day-of-week", () => {
  const expr = parseCron("0 9 * * 7");
  assert.equal(matches(expr, new Date(2026, 0, 4, 9, 0)), true);
  assert.equal(matches(expr, new Date(2026, 0, 5, 9, 0)), false);
});

test("nextAfter returns the next matching minute", () => {
  const next = nextAfter("*/15 * * * *", new Date(2026, 0, 1, 12, 7, 30));
  assert.equal(next.getMinutes(), 15);
  assert.equal(next.getHours(), 12);
});

test("nextAfterInTimezone honors daylight-saving offsets", () => {
  assert.equal(
    nextAfterInTimezone(
      "0 9 * * *",
      new Date("2026-07-27T12:00:00.000Z"),
      "America/Chicago",
    ).toISOString(),
    "2026-07-27T14:00:00.000Z",
  );
  assert.equal(
    nextAfterInTimezone(
      "0 9 * * *",
      new Date("2026-12-01T12:00:00.000Z"),
      "America/Chicago",
    ).toISOString(),
    "2026-12-01T15:00:00.000Z",
  );
  assert.throws(
    () =>
      nextAfterInTimezone(
        "0 9 * * *",
        new Date("2026-07-27T12:00:00.000Z"),
        "Mars/Olympus",
      ),
    /invalid timezone/,
  );
});
