export function formatRelativeTime(
  value: string | null | undefined,
  options: {
    readonly now?: number;
    readonly underMinute?: "seconds" | "just-now";
    readonly missing?: string;
  } = {},
): string {
  if (!value) return options.missing ?? "—";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.max(0, Math.floor(((options.now ?? Date.now()) - timestamp) / 1_000));
  if (seconds < 60) return options.underMinute === "just-now" ? "just now" : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDuration(
  value: number | null | undefined,
  options: {
    readonly secondsDecimals?: number;
    readonly includeMinutes?: boolean;
    readonly missing?: string;
    readonly allowZero?: boolean;
  } = {},
): string {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (!options.allowZero && value === 0)
  ) {
    return options.missing ?? "—";
  }
  if (value < 1_000) return `${value}ms`;
  if (options.includeMinutes && value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
  return `${(value / 1_000).toFixed(options.secondsDecimals ?? 1)}s`;
}

export function formatMoney(
  value: number,
  options: {
    readonly smallThreshold?: number;
    readonly smallDecimals?: number;
    readonly decimals?: number;
    readonly invalid?: string;
  } = {},
): string {
  if (!Number.isFinite(value)) return options.invalid ?? "—";
  const threshold = options.smallThreshold ?? 0.1;
  const decimals = value < threshold ? (options.smallDecimals ?? 3) : (options.decimals ?? 2);
  return `$${value.toFixed(decimals)}`;
}

export function formatBytes(value: number, invalid = "—"): string {
  if (!Number.isFinite(value) || value < 0) return invalid;
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function formatTimestamp(value: string, invalid = value): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? invalid : parsed.toLocaleString();
}

export function shortDigest(value: string, visibleCharacters = 20): string {
  return value.length > visibleCharacters + 4 ? `${value.slice(0, visibleCharacters)}…` : value;
}

export function formatStatusLabel(value: string): string {
  return value.replaceAll("_", " ");
}
