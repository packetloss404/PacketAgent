import type { AgentTriggerKind } from "@/lib/types";

export const TRIGGER_KINDS: AgentTriggerKind[] = ["manual", "schedule", "webhook", "email"];

export function triggerLabel(kind: AgentTriggerKind | undefined): string {
  switch (kind) {
    case "schedule":
      return "Scheduled";
    case "webhook":
      return "Webhook";
    case "email":
      return "Email";
    case "manual":
      return "Manual";
    default:
      return "Manual";
  }
}

export function triggerToneClass(kind: AgentTriggerKind | undefined): string {
  switch (kind) {
    case "schedule":
      return "border-signal-info/30 bg-signal-info/10 text-signal-info";
    case "webhook":
      return "border-ink-600 bg-ink-800 text-ink-100";
    case "email":
      return "border-signal-green/30 bg-signal-green/10 text-signal-green";
    default:
      return "border-ink-700 bg-ink-875 text-ink-200";
  }
}

export function describeNextRun(
  schedule: string | undefined,
  kind: AgentTriggerKind | undefined,
  from: Date = new Date(),
): string {
  if (kind === "manual") return "Manual runs only";
  if (kind === "webhook") return "Webhook-triggered";
  if (kind === "email") return "Email-triggered";
  if (!schedule || schedule.trim().length === 0) return "No schedule set";
  const next = nextCronRun(schedule.trim(), from);
  if (!next) return schedule.trim();
  const diffMs = next.getTime() - from.getTime();
  if (diffMs < 60_000) return "Next run within a minute";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `Next run in ~${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Next run in ~${hours}h`;
  const days = Math.round(hours / 24);
  return `Next run in ~${days}d`;
}

export function validateCronSchedule(schedule: string): string | null {
  const parts = schedule.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Enter a five-field cron schedule.";
  if (parts.length !== 5)
    return "Use five cron fields: minute hour day-of-month month day-of-week.";

  const fieldRanges: Array<[name: string, min: number, max: number]> = [
    ["minute", 0, 59],
    ["hour", 0, 23],
    ["day-of-month", 1, 31],
    ["month", 1, 12],
    ["day-of-week", 0, 7],
  ];

  for (let index = 0; index < parts.length; index += 1) {
    const [name, min, max] = fieldRanges[index];
    if (!isValidCronField(parts[index], min, max)) return `Invalid ${name} field: ${parts[index]}`;
  }

  return null;
}

function isValidCronField(field: string, min: number, max: number): boolean {
  return field.split(",").every((part) => isValidCronPart(part, min, max));
}

function isValidCronPart(part: string, min: number, max: number): boolean {
  if (!part) return false;
  const [range, step, extra] = part.split("/");
  if (extra !== undefined) return false;
  if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1)) return false;
  if (range === "*") return true;

  if (range.includes("-")) {
    const [start, end, trailing] = range.split("-");
    if (trailing !== undefined || !isCronNumber(start, min, max) || !isCronNumber(end, min, max))
      return false;
    return Number(start) <= Number(end);
  }

  return isCronNumber(range, min, max);
}

function isCronNumber(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return parsed >= min && parsed <= max;
}

export function nextCronRun(expr: string, from: Date): Date | null {
  const everyN = expr.match(/^\*\/(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/);
  if (everyN) {
    const interval = Math.max(1, Math.min(59, Number(everyN[1])));
    const next = new Date(from);
    next.setSeconds(0, 0);
    const minutes = next.getMinutes();
    const remainder = minutes % interval;
    const add = remainder === 0 ? interval : interval - remainder;
    next.setMinutes(minutes + add);
    return next;
  }
  const dailyOrWeekly = expr.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|\d(?:[-,]\d)*)$/);
  if (dailyOrWeekly) {
    const minute = Number(dailyOrWeekly[1]);
    const hour = Number(dailyOrWeekly[2]);
    const dowSpec = dailyOrWeekly[3];
    const allowedDays = dowSpec === "*" ? null : parseDayOfWeek(dowSpec);
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    for (let offset = 0; offset < 8; offset += 1) {
      const probe = new Date(candidate);
      probe.setDate(candidate.getDate() + offset);
      probe.setHours(hour, minute, 0, 0);
      if (probe.getTime() <= from.getTime()) continue;
      if (allowedDays && !allowedDays.has(probe.getDay())) continue;
      return probe;
    }
  }
  return null;
}

function parseDayOfWeek(spec: string): Set<number> {
  const days = new Set<number>();
  for (const part of spec.split(",")) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map((value) => Number(value) % 7);
      for (let day = start; ; day = (day + 1) % 7) {
        days.add(day);
        if (day === end) break;
      }
    } else {
      days.add(Number(part) % 7);
    }
  }
  return days;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
