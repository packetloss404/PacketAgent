import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratedAppSmokeTranscript } from "./generated-app-smoke-transcript.js";

test("generated-app smoke transcripts bind bounded execution evidence to one checkpoint", () => {
  const transcript = buildGeneratedAppSmokeTranscript({
    workspaceId: "workspace-1",
    appId: "app-1",
    checkpointId: "checkpoint-1",
    source: "approval",
    recordedAt: "2026-08-01T12:00:01.000Z",
    result: {
      status: "pass",
      message: "TypeScript and Vite passed.",
      checks: [{ name: "TypeScript", status: "pass", detail: "tsc --noEmit passed" }],
      blockers: [],
      execution: {
        startedAt: "2026-08-01T12:00:00.000Z",
        completedAt: "2026-08-01T12:00:01.000Z",
        durationMs: 1_000,
        runner: "isolated-sandbox",
        validatorSource: "real",
      },
    },
  });

  assert.equal(transcript.schemaVersion, "packetagent.generated-app-smoke-transcript/v1");
  assert.equal(transcript.checkpointId, "checkpoint-1");
  assert.equal(transcript.status, "pass");
  assert.equal(transcript.runner, "isolated-sandbox");
  assert.equal(transcript.durationMs, 1_000);
  assert.match(transcript.id, /^gapp_smoke_[a-f0-9]{24}$/);
  assert.deepEqual(transcript.checks, [
    { name: "TypeScript", status: "pass", detail: "tsc --noEmit passed" },
  ]);
});
