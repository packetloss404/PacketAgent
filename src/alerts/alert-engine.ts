import { randomUUID } from "node:crypto";
import type { OperationsHealthReport } from "../operations-health.js";
import type { JobTypeMetrics } from "../jobs/scheduler-metrics.js";

export const ALERT_JOB_FAILURE_RATE_THRESHOLD_ENV = "PACKETAGENT_ALERT_JOB_FAILURE_RATE_THRESHOLD";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertRule {
  id: string;
  description: string;
  severity: AlertSeverity;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  observedAt: string;
  context: Record<string, unknown>;
}

export interface EvaluateAlertsInput {
  health: OperationsHealthReport;
  metrics: JobTypeMetrics[];
  jobFailureRateThreshold?: number;
  jobFailureMinSamples?: number;
}

export interface EvaluateAlertsDeps {
  now?: () => Date;
  generateId?: () => string;
}

export const ALERT_RULES: readonly AlertRule[] = [
  {
    id: "subsystem-degraded",
    description: "Emitted when an operations health subsystem reports degraded status.",
    severity: "warning",
  },
  {
    id: "subsystem-down",
    description: "Emitted when an operations health subsystem reports down status.",
    severity: "critical",
  },
  {
    id: "job-failure-rate",
    description: "Emitted when a job type's recent failure rate exceeds the configured threshold.",
    severity: "warning",
  },
];

const DEFAULT_JOB_FAILURE_RATE_THRESHOLD = 0.5;
const DEFAULT_JOB_FAILURE_MIN_SAMPLES = 5;
const CRITICAL_JOB_FAILURE_RATE = 0.8;

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function dedupKey(ruleId: string, context: Record<string, unknown>): string {
  const subsystem = context.subsystem;
  const type = context.type;
  if (typeof subsystem === "string") return `${ruleId}::subsystem::${subsystem}`;
  if (typeof type === "string") return `${ruleId}::type::${type}`;
  return ruleId;
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function evaluateAlerts(input: EvaluateAlertsInput, deps: EvaluateAlertsDeps = {}): AlertEvent[] {
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => randomUUID());
  const observedAt = now().toISOString();

  const threshold = input.jobFailureRateThreshold ?? DEFAULT_JOB_FAILURE_RATE_THRESHOLD;
  const minSamples = input.jobFailureMinSamples ?? DEFAULT_JOB_FAILURE_MIN_SAMPLES;

  const seen = new Set<string>();
  const events: AlertEvent[] = [];

  for (const subsystem of input.health.subsystems) {
    if (subsystem.status !== "degraded" && subsystem.status !== "down") continue;
    const ruleId = subsystem.status === "down" ? "subsystem-down" : "subsystem-degraded";
    const severity: AlertSeverity = subsystem.status === "down" ? "critical" : "warning";
    const context: Record<string, unknown> = {
      subsystem: subsystem.name,
      status: subsystem.status,
      observedAt: subsystem.observedAt ?? null,
    };
    const key = dedupKey(ruleId, context);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      id: generateId(),
      ruleId,
      severity,
      title: `Subsystem ${subsystem.name} ${subsystem.status}`,
      detail: subsystem.detail,
      observedAt,
      context,
    });
  }

  for (const metric of input.metrics) {
    if (metric.totalRuns < minSamples) continue;
    const failures = metric.failedRuns + metric.canceledRuns;
    if (metric.totalRuns <= 0) continue;
    const failureRate = failures / metric.totalRuns;
    if (failureRate <= threshold) continue;
    const severity: AlertSeverity = failureRate > CRITICAL_JOB_FAILURE_RATE ? "critical" : "warning";
    const context: Record<string, unknown> = {
      type: metric.type,
      totalRuns: metric.totalRuns,
      failedRuns: metric.failedRuns,
      canceledRuns: metric.canceledRuns,
      succeededRuns: metric.succeededRuns,
      failureRate,
    };
    const key = dedupKey("job-failure-rate", context);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      id: generateId(),
      ruleId: "job-failure-rate",
      severity,
      title: `Job type ${metric.type} failing`,
      detail: `${formatPercent(failureRate)} failure rate over ${metric.totalRuns} recent runs`,
      observedAt,
      context,
    });
  }

  events.sort((a, b) => {
    const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return a.ruleId.localeCompare(b.ruleId);
  });

  return events;
}
