import { createHash } from "node:crypto";
import type {
  GeneratedAppSmokeTranscriptRecord,
  GeneratedAppSmokeTranscriptSource,
} from "./store/types.js";

export interface GeneratedAppSmokeResultLike {
  readonly status: string;
  readonly message: string;
  readonly checks: readonly {
    readonly name: string;
    readonly status: string;
    readonly detail: string;
  }[];
  readonly blockers: readonly string[];
  readonly execution?: {
    readonly startedAt: string;
    readonly completedAt: string;
    readonly durationMs: number;
    readonly runner: "isolated-sandbox" | "not-run";
    readonly validatorSource?: string;
  };
}

export function buildGeneratedAppSmokeTranscript(input: {
  readonly workspaceId: string;
  readonly appId: string;
  readonly checkpointId: string;
  readonly source: GeneratedAppSmokeTranscriptSource;
  readonly result: GeneratedAppSmokeResultLike;
  readonly recordedAt?: string;
  readonly derivedFromTranscriptId?: string;
}): GeneratedAppSmokeTranscriptRecord {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const execution = input.result.execution ?? {
    startedAt: recordedAt,
    completedAt: recordedAt,
    durationMs: 0,
    runner: "not-run" as const,
  };
  const identity = [
    input.workspaceId,
    input.appId,
    input.checkpointId,
    input.source,
    execution.completedAt,
    input.result.status,
  ].join(":");

  return {
    schemaVersion: "packetagent.generated-app-smoke-transcript/v1",
    id: `gapp_smoke_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
    workspaceId: input.workspaceId,
    appId: input.appId,
    checkpointId: input.checkpointId,
    source: input.source,
    status: normalizeStatus(input.result.status),
    summary: bounded(input.result.message, 2_000),
    checks: input.result.checks.slice(0, 200).map((check) => ({
      name: bounded(check.name, 200),
      status: normalizeStatus(check.status),
      detail: bounded(check.detail, 2_000),
    })),
    blockers: input.result.blockers.slice(0, 100).map((blocker) => bounded(blocker, 2_000)),
    runner: execution.runner,
    ...(execution.validatorSource
      ? { validatorSource: bounded(execution.validatorSource, 100) }
      : {}),
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    durationMs: Math.max(0, Math.floor(execution.durationMs)),
    recordedAt,
    ...(input.derivedFromTranscriptId
      ? { derivedFromTranscriptId: input.derivedFromTranscriptId }
      : {}),
  };
}

function normalizeStatus(value: string): GeneratedAppSmokeTranscriptRecord["status"] {
  if (value === "pass" || value === "fail" || value === "warn") return value;
  return "pending";
}

function bounded(value: string, maximum: number): string {
  const clean = String(value ?? "").trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 1)}…` : clean;
}
