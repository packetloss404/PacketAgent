import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { redactedErrorMessage } from "../security/redaction.js";
import type { ToolDefinition, ToolResult } from "./types.js";

type Env = Record<string, string | undefined>;

export interface EmailSendInput extends Record<string, unknown> {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  secure: boolean;
}

export interface SmtpMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
}

export interface SmtpSendResult {
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
}

export interface SmtpAdapter {
  send(message: SmtpMessage): Promise<SmtpSendResult>;
}

export type SmtpAdapterFactory = (config: SmtpConfig) => SmtpAdapter | Promise<SmtpAdapter>;

export interface EmailSendToolOptions {
  env?: Env;
  adapterFactory?: SmtpAdapterFactory;
}

export interface SqlQueryInput extends Record<string, unknown> {
  sql: string;
  params?: unknown[];
  write?: boolean;
}

export interface SqlQueryToolOptions {
  dbRoot?: string;
}

interface AgentSqlitePathInput {
  dbRoot?: string;
  workspaceId: string;
  agentId: string;
}

const DEFAULT_SQL_ROOT = path.join("data", "agent-sql");
const EMAIL_TIMEOUT_MS = 20_000;
const SQLITE_TIMEOUT_MS = 30_000;

const recipientSchema = {
  anyOf: [
    { type: "string", minLength: 1 },
    { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
  ],
};

const safeReadPragmas = new Set([
  "collation_list",
  "database_list",
  "encoding",
  "foreign_key_check",
  "foreign_key_list",
  "function_list",
  "index_info",
  "index_list",
  "index_xinfo",
  "integrity_check",
  "module_list",
  "quick_check",
  "schema_version",
  "table_info",
  "table_list",
  "table_xinfo",
  "user_version",
]);

const dangerousPragmas = new Set([
  "application_id",
  "auto_vacuum",
  "busy_timeout",
  "cache_size",
  "case_sensitive_like",
  "cell_size_check",
  "checkpoint_fullfsync",
  "defer_foreign_keys",
  "foreign_keys",
  "fullfsync",
  "hard_heap_limit",
  "ignore_check_constraints",
  "incremental_vacuum",
  "journal_mode",
  "journal_size_limit",
  "legacy_alter_table",
  "locking_mode",
  "max_page_count",
  "mmap_size",
  "optimize",
  "page_size",
  "query_only",
  "read_uncommitted",
  "recursive_triggers",
  "reverse_unordered_selects",
  "secure_delete",
  "soft_heap_limit",
  "synchronous",
  "temp_store",
  "temp_store_directory",
  "trusted_schema",
  "wal_autocheckpoint",
  "wal_checkpoint",
  "writable_schema",
]);

export function createEmailSendTool(options: EmailSendToolOptions = {}): ToolDefinition<EmailSendInput> {
  return {
    name: "email_send",
    description: "Send an email through the configured SMTP adapter.",
    inputSchema: {
      type: "object",
      properties: {
        to: recipientSchema,
        subject: { type: "string", minLength: 1 },
        text: { type: "string" },
        html: { type: "string" },
        from: { type: "string", minLength: 1 },
        cc: recipientSchema,
        bcc: recipientSchema,
        replyTo: { type: "string", minLength: 1 },
      },
      required: ["to", "subject", "text"],
      additionalProperties: false,
    },
    side: "write",
    effect: {
      describe: () => ({
        classification: "non_replayable_mutation",
        operation: "email.send",
      }),
    },
    timeoutMs: EMAIL_TIMEOUT_MS,
    async handle(input) {
      const env = options.env ?? process.env;
      const adapterFactory = options.adapterFactory;
      if (!adapterFactory) {
        return {
          ok: false,
          error: "SMTP adapter is not configured for email_send; provide an adapter factory before sending mail.",
        };
      }

      const parsed = parseEmailInput(input, env);
      if (!parsed.ok) return parsed;
      const { config, message } = parsed.output as { config: SmtpConfig; message: SmtpMessage };

      try {
        const adapter = await adapterFactory(config);
        const sent = await adapter.send(message);
        return {
          ok: true,
          output: {
            messageId: sent.messageId,
            acceptedCount: sent.accepted?.length ?? message.to.length,
            rejectedCount: sent.rejected?.length ?? 0,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: `email send failed: ${redactEmailError(error, env, message)}`,
        };
      }
    },
  };
}

export const emailSendTool = createEmailSendTool();

export function createSqlQueryTool(options: SqlQueryToolOptions = {}): ToolDefinition<SqlQueryInput> {
  return {
    name: "sql_query",
    description: "Run a scoped SQLite query for the current agent. SELECT and safe PRAGMA reads are allowed by default; mutations require write=true.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", minLength: 1 },
        params: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "null" },
            ],
          },
          default: [],
        },
        write: { type: "boolean", default: false },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    side: "write",
    effect: {
      describe: (input) => ({
        classification:
          input.write === true
            ? ("non_replayable_mutation" as const)
            : ("read_only" as const),
        operation: input.write === true ? "sql.mutate" : "sql.read",
      }),
    },
    timeoutMs: SQLITE_TIMEOUT_MS,
    async handle(input, ctx) {
      const parsed = parseSqlInput(input);
      if (!parsed.ok) return parsed;
      if (!ctx.agentId) return { ok: false, error: "sql_query requires ctx.agentId for scoped storage" };

      const { statement, params, write } = parsed.output as { statement: string; params: SQLInputValue[]; write: boolean };
      const policy = validateSqlPolicy(statement, write);
      if (!policy.ok) return policy;

      let dbPath: string;
      try {
        dbPath = resolveAgentSqlitePath({ dbRoot: options.dbRoot, workspaceId: ctx.workspaceId, agentId: ctx.agentId });
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }

      mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        const prepared = db.prepare(statement);
        if (policy.kind === "read") {
          const rows = prepared.all(...params) as Array<Record<string, unknown>>;
          return { ok: true, output: { rows, count: rows.length } };
        }

        const result = prepared.run(...params);
        return {
          ok: true,
          output: {
            changes: result.changes,
            lastInsertRowid: normalizeSqliteInteger(result.lastInsertRowid),
          },
        };
      } catch (error) {
        return { ok: false, error: `sql query failed: ${(error as Error).message}` };
      } finally {
        db.close();
      }
    },
  };
}

export const sqlQueryTool = createSqlQueryTool();

export function resolveAgentSqlitePath(input: AgentSqlitePathInput): string {
  const root = path.resolve(input.dbRoot ?? path.join(process.cwd(), DEFAULT_SQL_ROOT));
  const workspaceSegment = safePathSegment(input.workspaceId, "workspace");
  const agentSegment = safePathSegment(input.agentId, "agent");
  const dbPath = path.resolve(root, workspaceSegment, `${agentSegment}.sqlite`);
  assertInsidePath(root, dbPath);
  return dbPath;
}

function parseEmailInput(input: EmailSendInput, env: Env): ToolResult {
  const to = normalizeRecipients(input.to);
  if (to.length === 0) return { ok: false, error: "email_send requires at least one recipient in to" };
  if (!isNonEmptyString(input.subject)) return { ok: false, error: "email_send requires a non-empty subject" };
  if (typeof input.text !== "string") return { ok: false, error: "email_send requires text content" };
  if (input.html !== undefined && typeof input.html !== "string") return { ok: false, error: "email_send html must be a string" };

  const cc = normalizeOptionalRecipients(input.cc);
  const bcc = normalizeOptionalRecipients(input.bcc);
  const from = input.from?.trim() || env.SMTP_FROM?.trim();
  if (!from) return { ok: false, error: "email_send requires a from address or SMTP_FROM" };
  if (input.replyTo !== undefined && !isNonEmptyString(input.replyTo)) {
    return { ok: false, error: "email_send replyTo must be a non-empty string" };
  }

  const host = env.SMTP_HOST?.trim();
  const rawPort = env.SMTP_PORT?.trim();
  if (!host) return { ok: false, error: "email_send requires SMTP_HOST" };
  if (!rawPort) return { ok: false, error: "email_send requires SMTP_PORT" };
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { ok: false, error: "email_send requires SMTP_PORT to be an integer from 1 to 65535" };
  }

  const message: SmtpMessage = {
    from,
    to,
    subject: input.subject.trim(),
    text: input.text,
    ...(input.html !== undefined ? { html: input.html } : {}),
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo.trim() } : {}),
  };
  return {
    ok: true,
    output: {
      config: {
        host,
        port,
        ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
        ...(env.SMTP_PASS ? { pass: env.SMTP_PASS } : {}),
        from,
        secure: parseSmtpSecure(env.SMTP_SECURE),
      },
      message,
    },
  };
}

function normalizeRecipients(value: string | string[] | undefined): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeOptionalRecipients(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : normalizeRecipients(value);
}

function parseSmtpSecure(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function redactEmailError(error: unknown, env: Env, message: SmtpMessage): string {
  const recipients = [
    ...message.to,
    ...(message.cc ?? []),
    ...(message.bcc ?? []),
    ...(message.replyTo ? [message.replyTo] : []),
  ];
  let redacted = redactedErrorMessage(error, [env.SMTP_PASS, env.SMTP_USER]);
  for (const recipient of recipients) {
    if (!recipient) continue;
    redacted = redacted.split(recipient).join("[redacted-recipient]");
  }
  return redacted;
}

function parseSqlInput(input: SqlQueryInput): ToolResult {
  if (typeof input.sql !== "string" || input.sql.trim() === "") {
    return { ok: false, error: "sql_query requires a non-empty sql string" };
  }

  const statementResult = singleStatement(input.sql);
  if (!statementResult.ok) return statementResult;
  const params = input.params ?? [];
  if (!Array.isArray(params)) return { ok: false, error: "sql_query params must be an array" };

  const normalizedParams: SQLInputValue[] = [];
  for (const value of params) {
    if (value === null || typeof value === "string" || typeof value === "number") {
      normalizedParams.push(value);
    } else {
      return { ok: false, error: "sql_query params may only contain strings, numbers, or null" };
    }
  }

  return {
    ok: true,
    output: {
      statement: statementResult.output,
      params: normalizedParams,
      write: input.write === true,
    },
  };
}

function validateSqlPolicy(statement: string, write: boolean): ToolResult & { kind?: "read" | "write" } {
  const keyword = firstSqlKeyword(statement);
  if (!keyword) return { ok: false, error: "sql_query requires a SQL statement" };
  if (keyword === "attach" || keyword === "detach") {
    return { ok: false, error: "ATTACH and DETACH are not allowed in sql_query" };
  }
  if (keyword === "select") return { ok: true, kind: "read" };
  if (keyword === "pragma") return validatePragmaPolicy(statement);

  if (["create", "insert", "update", "delete", "alter", "drop", "replace"].includes(keyword)) {
    if (!write) return { ok: false, error: `${keyword.toUpperCase()} requires write=true` };
    return { ok: true, kind: "write" };
  }

  return { ok: false, error: `SQL statements starting with ${keyword.toUpperCase()} are not allowed` };
}

function validatePragmaPolicy(statement: string): ToolResult & { kind?: "read" } {
  const pragma = statement.match(/^\s*pragma\s+([a-zA-Z_][\w]*)/i)?.[1]?.toLowerCase();
  if (!pragma) return { ok: false, error: "PRAGMA statement must name a pragma" };
  if (dangerousPragmas.has(pragma)) return { ok: false, error: `PRAGMA ${pragma} is not allowed` };
  if (!safeReadPragmas.has(pragma)) return { ok: false, error: `PRAGMA ${pragma} is not on the safe read allowlist` };
  if (pragmaHasAssignment(statement)) return { ok: false, error: "PRAGMA assignments are not allowed" };
  return { ok: true, kind: "read" };
}

function pragmaHasAssignment(statement: string): boolean {
  const withoutComments = stripSqlComments(statement);
  return /\bpragma\b[\s\S]*=/.test(withoutComments.toLowerCase());
}

function singleStatement(sql: string): ToolResult & { output?: string } {
  const trimmed = sql.trim();
  const semicolons = topLevelSemicolonIndexes(trimmed);
  if (semicolons.length > 1) return { ok: false, error: "sql_query rejects multiple statements" };
  if (semicolons.length === 0) return { ok: true, output: trimmed };

  const firstSemicolon = semicolons[0];
  if (hasSqlToken(trimmed.slice(firstSemicolon + 1))) {
    return { ok: false, error: "sql_query rejects multiple statements" };
  }
  const statement = trimmed.slice(0, firstSemicolon).trim();
  if (!statement) return { ok: false, error: "sql_query requires a SQL statement" };
  return { ok: true, output: statement };
}

function topLevelSemicolonIndexes(sql: string): number[] {
  const indexes: number[] = [];
  scanSql(sql, (char, index) => {
    if (char === ";") indexes.push(index);
  });
  return indexes;
}

function hasSqlToken(sql: string): boolean {
  let state: "normal" | "line-comment" | "block-comment" = "normal";
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "normal";
        i += 1;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      state = "line-comment";
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      i += 1;
      continue;
    }
    if (/\s/.test(char)) continue;
    return true;
  }
  return false;
}

function firstSqlKeyword(statement: string): string | null {
  const stripped = stripLeadingSqlComments(statement).trimStart();
  return stripped.match(/^([a-zA-Z]+)/)?.[1]?.toLowerCase() ?? null;
}

function stripLeadingSqlComments(sql: string): string {
  let rest = sql;
  while (true) {
    const trimmed = rest.trimStart();
    if (trimmed.startsWith("--")) {
      const end = trimmed.indexOf("\n");
      rest = end === -1 ? "" : trimmed.slice(end + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      rest = end === -1 ? "" : trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

function stripSqlComments(sql: string): string {
  let out = "";
  scanSql(sql, (char) => { out += char; });
  return out;
}

function scanSql(sql: string, onNormalChar: (char: string, index: number) => void): void {
  let state: "normal" | "single" | "double" | "backtick" | "bracket" | "line-comment" | "block-comment" = "normal";
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "normal";
        i += 1;
      }
      continue;
    }
    if (state === "single") {
      if (char === "'" && next === "'") {
        i += 1;
      } else if (char === "'") {
        state = "normal";
      }
      continue;
    }
    if (state === "double") {
      if (char === "\"" && next === "\"") {
        i += 1;
      } else if (char === "\"") {
        state = "normal";
      }
      continue;
    }
    if (state === "backtick") {
      if (char === "`" && next === "`") {
        i += 1;
      } else if (char === "`") {
        state = "normal";
      }
      continue;
    }
    if (state === "bracket") {
      if (char === "]") state = "normal";
      continue;
    }

    if (char === "-" && next === "-") {
      state = "line-comment";
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      i += 1;
      continue;
    }
    if (char === "'") {
      state = "single";
      continue;
    }
    if (char === "\"") {
      state = "double";
      continue;
    }
    if (char === "`") {
      state = "backtick";
      continue;
    }
    if (char === "[") {
      state = "bracket";
      continue;
    }

    onNormalChar(char, i);
  }
}

function normalizeSqliteInteger(value: number | bigint): number | string {
  return typeof value === "bigint" ? value.toString() : value;
}

function safePathSegment(value: string, fallback: string): string {
  const segment = value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
  if (segment === "." || segment === ".." || segment.includes("..")) {
    throw new Error(`unsafe sql_query path segment: ${value}`);
  }
  return segment;
}

function assertInsidePath(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`sql_query database path escapes root: ${child}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
