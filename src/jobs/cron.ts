interface CronField {
  values: Set<number>;
}

export interface CronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const FIELD_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function parseField(
  token: string,
  [min, max]: [number, number],
  normalize: (value: number) => number = (value) => value,
): CronField {
  const values = new Set<number>();
  for (const piece of token.split(",")) {
    let step = 1;
    let range: [number, number] = [min, max];
    let body = piece;
    if (piece.includes("/")) {
      const [base, stepStr] = piece.split("/");
      step = Number(stepStr);
      if (!Number.isFinite(step) || step <= 0) throw new Error(`cron: invalid step "${piece}"`);
      body = base;
    }
    if (body === "*" || body === "") {
      range = [min, max];
    } else if (body.includes("-")) {
      const [a, b] = body.split("-").map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b))
        throw new Error(`cron: invalid range "${piece}"`);
      if (a > b) throw new Error(`cron: invalid range "${piece}"`);
      range = [a, b];
    } else {
      const v = Number(body);
      if (!Number.isFinite(v)) throw new Error(`cron: invalid value "${piece}"`);
      range = [v, v];
    }
    if (range[0] < min || range[1] > max) throw new Error(`cron: out-of-range value in "${piece}"`);
    for (let v = range[0]; v <= range[1]; v += step) values.add(normalize(v));
  }
  return { values };
}

export function parseCron(expr: string): CronExpression {
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) throw new Error("cron: expression must have 5 fields");
  return {
    minute: parseField(tokens[0], FIELD_RANGES[0]),
    hour: parseField(tokens[1], FIELD_RANGES[1]),
    dayOfMonth: parseField(tokens[2], FIELD_RANGES[2]),
    month: parseField(tokens[3], FIELD_RANGES[3]),
    dayOfWeek: parseField(tokens[4], FIELD_RANGES[4], normalizeDayOfWeek),
  };
}

export function matches(expr: CronExpression, date: Date): boolean {
  if (!expr.minute.values.has(date.getMinutes())) return false;
  if (!expr.hour.values.has(date.getHours())) return false;
  if (!expr.dayOfMonth.values.has(date.getDate())) return false;
  if (!expr.month.values.has(date.getMonth() + 1)) return false;
  if (!expr.dayOfWeek.values.has(date.getDay())) return false;
  return true;
}

export function nextAfter(exprStr: string, after: Date): Date {
  const expr = parseCron(exprStr);
  const cursor = new Date(after.getTime() + 60_000);
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (matches(expr, cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(`cron: no match within a year for "${exprStr}"`);
}

export function nextAfterInTimezone(exprStr: string, after: Date, timezone: string): Date {
  const expr = parseCron(exprStr);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
  } catch {
    throw new Error(`cron: invalid timezone "${timezone}"`);
  }
  const cursor = new Date(after.getTime() + 60_000);
  cursor.setUTCSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 366; i += 1) {
    const parts = zonedParts(formatter, cursor);
    if (
      expr.minute.values.has(parts.minute) &&
      expr.hour.values.has(parts.hour) &&
      expr.dayOfMonth.values.has(parts.dayOfMonth) &&
      expr.month.values.has(parts.month) &&
      expr.dayOfWeek.values.has(parts.dayOfWeek)
    ) {
      return new Date(cursor);
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error(`cron: no match within a year for "${exprStr}" in timezone "${timezone}"`);
}

function zonedParts(
  formatter: Intl.DateTimeFormat,
  date: Date,
): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday);
  if (weekday < 0) throw new Error("cron: could not resolve timezone weekday");
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    dayOfMonth: Number(values.day),
    month: Number(values.month),
    dayOfWeek: weekday,
  };
}
