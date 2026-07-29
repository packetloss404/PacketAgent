import assert from "node:assert/strict";
import test from "node:test";
import { malformedToolCalls, parseToolInput } from "./tool-input.js";

test("tool input parser accepts JSON objects and native objects", () => {
  assert.deepEqual(parseToolInput('{"query":"packet"}'), {
    input: { query: "packet" },
  });
  assert.deepEqual(parseToolInput({ query: "packet" }), {
    input: { query: "packet" },
  });
});

test("tool input parser preserves a typed failure marker without retaining raw input", () => {
  assert.deepEqual(parseToolInput('{"query":'), {
    input: {},
    inputError: "malformed_json",
  });
  assert.deepEqual(parseToolInput(["not", "an", "object"]), {
    input: {},
    inputError: "not_an_object",
  });
});

test("malformed tool call detection is explicit and deterministic", () => {
  assert.deepEqual(
    malformedToolCalls([
      { id: "ok", name: "search", input: { query: "packet" } },
      {
        id: "bad",
        name: "search",
        input: {},
        inputError: "malformed_json",
      },
    ]).map((toolCall) => toolCall.id),
    ["bad"],
  );
});
