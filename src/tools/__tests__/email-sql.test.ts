import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createEmailSendTool,
  createSqlQueryTool,
  parseSmtpCredential,
  resolveAgentSqlitePath,
  type SmtpConfig,
  type SmtpMessage,
} from "../email-sql.js";
import type { ToolContext } from "../types.js";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: "workspace-one",
    userId: "user-one",
    agentId: "agent-one",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "packetagent-email-sql-"));
}

test("email_send delivers through an injected SMTP adapter", async () => {
  let seenConfig: SmtpConfig | undefined;
  let sentMessage: SmtpMessage | undefined;
  const tool = createEmailSendTool({
    env: {
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "2525",
      SMTP_USER: "bot",
      SMTP_PASS: "smtp-secret",
      SMTP_FROM: "noreply@example.com",
      SMTP_SECURE: "true",
    },
    adapterFactory(config) {
      seenConfig = config;
      return {
        async send(message) {
          sentMessage = message;
          return {
            messageId: `${"m".repeat(512)}\r\nignored`,
            accepted: Array.from({ length: 101 }, () => "ada@example.com"),
            rejected: Array.from({ length: 101 }, () => "rejected@example.com"),
          };
        },
      };
    },
  });

  const result = await tool.handle(
    {
      to: ["ada@example.com"],
      cc: "team@example.com",
      bcc: "audit@example.com",
      replyTo: "reply@example.com",
      subject: "Hello",
      text: "Plain body",
      html: "<p>Plain body</p>",
    },
    context(),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    messageId: "m".repeat(512),
    acceptedCount: 100,
    rejectedCount: 100,
  });
  assert.deepEqual(seenConfig, {
    host: "smtp.example.test",
    port: 2525,
    user: "bot",
    pass: "smtp-secret",
    from: "noreply@example.com",
    secure: true,
    requireTls: true,
  });
  assert.deepEqual(sentMessage, {
    from: "noreply@example.com",
    to: ["ada@example.com"],
    cc: ["team@example.com"],
    bcc: ["audit@example.com"],
    replyTo: "reply@example.com",
    subject: "Hello",
    text: "Plain body",
    html: "<p>Plain body</p>",
  });
});

test("email_send uses the default TLS SMTP port without an injected adapter factory", async () => {
  let sends = 0;
  const tool = createEmailSendTool({
    env: {
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "587",
      SMTP_USER: "bot",
      SMTP_PASS: "smtp-secret",
      SMTP_FROM: "noreply@example.com",
    },
    smtp: {
      async send(input) {
        sends += 1;
        assert.equal(input.config.host, "smtp.example.test");
        assert.equal(input.config.requireTls, true);
        assert.equal(input.config.pass, "smtp-secret");
        return { messageId: "default-transport", accepted: [...input.message.to] };
      },
    },
  });

  const result = await tool.handle(
    {
      to: "ada@example.com",
      subject: "Hello",
      text: "Plain body",
    },
    context(),
  );

  assert.equal(result.ok, true);
  assert.equal(sends, 1);
  assert.deepEqual(result.output, {
    messageId: "default-transport",
    acceptedCount: 1,
    rejectedCount: 0,
  });
});

test("email_send redacts SMTP secrets and recipients from adapter errors", async () => {
  const tool = createEmailSendTool({
    env: {
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "587",
      SMTP_USER: "bot-user",
      SMTP_PASS: "smtp-pass-secret",
      SMTP_FROM: "noreply@example.com",
    },
    adapterFactory() {
      return {
        async send() {
          throw new Error("auth smtp-pass-secret failed for ada@example.com and audit@example.com");
        },
      };
    },
  });

  const result = await tool.handle(
    {
      to: "ada@example.com",
      bcc: "audit@example.com",
      subject: "Hello",
      text: "Plain body",
    },
    context(),
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /email send failed/);
  assert.doesNotMatch(result.error ?? "", /smtp-pass-secret/);
  assert.doesNotMatch(result.error ?? "", /ada@example\.com/);
  assert.doesNotMatch(result.error ?? "", /audit@example\.com/);
  assert.match(result.error ?? "", /\[redacted/);
});

test("SMTP vault configuration is strict, TLS-required, and header-injection safe", () => {
  const valid = parseSmtpCredential(
    JSON.stringify({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTls: true,
      from: "PacketAgent <noreply@example.com>",
      user: "smtp-user",
      pass: "smtp-secret",
    }),
  );
  assert.equal(valid.ok, true);

  for (const value of [
    "{not-json",
    JSON.stringify({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTls: false,
      from: "noreply@example.com",
    }),
    JSON.stringify({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTls: true,
      from: "noreply@example.com\r\nBcc: stolen@example.com",
    }),
    JSON.stringify({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTls: true,
      from: "noreply@example.com",
      unexpected: "field",
    }),
    JSON.stringify({
      host: "smtp.example.com",
      port: 587,
      secure: "false",
      requireTls: true,
      from: "noreply@example.com",
    }),
    JSON.stringify({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTls: "true",
      from: "noreply@example.com",
    }),
  ]) {
    assert.equal(parseSmtpCredential(value).ok, false);
  }
});

test("sql_query requires write=true for mutations and returns rows for reads", async () => {
  const dbRoot = makeTempDir();
  try {
    const tool = createSqlQueryTool({ dbRoot });
    const ctx = context();

    const rejected = await tool.handle(
      {
        sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
      },
      ctx,
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /CREATE requires write=true/);

    const created = await tool.handle(
      {
        sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
        write: true,
      },
      ctx,
    );
    assert.equal(created.ok, true);

    const inserted = await tool.handle(
      {
        sql: "INSERT INTO items (name) VALUES (?)",
        params: ["first"],
        write: true,
      },
      ctx,
    );
    assert.equal(inserted.ok, true);
    assert.deepEqual(inserted.output, { changes: 1, lastInsertRowid: 1 });

    const read = await tool.handle(
      {
        sql: "SELECT id, name FROM items WHERE name = ?",
        params: ["first"],
      },
      ctx,
    );
    assert.equal(read.ok, true);
    const output = read.output as { rows: Array<{ id: number; name: string }>; count: number };
    assert.equal(output.count, 1);
    assert.deepEqual(
      output.rows.map((row) => ({ id: row.id, name: row.name })),
      [{ id: 1, name: "first" }],
    );
  } finally {
    rmSync(dbRoot, { recursive: true, force: true });
  }
});

test("sql_query scopes SQLite files by workspace and agent", async () => {
  const dbRoot = makeTempDir();
  try {
    const tool = createSqlQueryTool({ dbRoot });
    const agentA = context({ workspaceId: "workspace", agentId: "agent-a" });
    const agentB = context({ workspaceId: "workspace", agentId: "agent-b" });

    assert.notEqual(
      resolveAgentSqlitePath({
        dbRoot,
        workspaceId: agentA.workspaceId,
        agentId: agentA.agentId ?? "",
      }),
      resolveAgentSqlitePath({
        dbRoot,
        workspaceId: agentB.workspaceId,
        agentId: agentB.agentId ?? "",
      }),
    );

    assert.equal(
      (await tool.handle({ sql: "CREATE TABLE notes (body TEXT NOT NULL)", write: true }, agentA))
        .ok,
      true,
    );
    assert.equal(
      (
        await tool.handle(
          { sql: "INSERT INTO notes (body) VALUES (?)", params: ["from-a"], write: true },
          agentA,
        )
      ).ok,
      true,
    );
    assert.equal(
      (await tool.handle({ sql: "CREATE TABLE notes (body TEXT NOT NULL)", write: true }, agentB))
        .ok,
      true,
    );

    const readB = await tool.handle({ sql: "SELECT body FROM notes" }, agentB);
    assert.equal(readB.ok, true);
    const outputB = readB.output as { rows: Array<{ body: string }>; count: number };
    assert.deepEqual(outputB.rows, []);
    assert.equal(outputB.count, 0);
  } finally {
    rmSync(dbRoot, { recursive: true, force: true });
  }
});

test("sql_query rejects multiple statements, ATTACH, and dangerous PRAGMAs", async () => {
  const dbRoot = makeTempDir();
  try {
    const tool = createSqlQueryTool({ dbRoot });
    const ctx = context();

    const multiple = await tool.handle({ sql: "SELECT 1; SELECT 2" }, ctx);
    assert.equal(multiple.ok, false);
    assert.match(multiple.error ?? "", /multiple statements/);

    const quotedTrailingToken = await tool.handle({ sql: "SELECT 1; 'still another token'" }, ctx);
    assert.equal(quotedTrailingToken.ok, false);
    assert.match(quotedTrailingToken.error ?? "", /multiple statements/);

    const attach = await tool.handle(
      { sql: "ATTACH DATABASE 'elsewhere.sqlite' AS other", write: true },
      ctx,
    );
    assert.equal(attach.ok, false);
    assert.match(attach.error ?? "", /ATTACH and DETACH are not allowed/);

    const dangerousPragma = await tool.handle({ sql: "PRAGMA writable_schema = ON" }, ctx);
    assert.equal(dangerousPragma.ok, false);
    assert.match(dangerousPragma.error ?? "", /PRAGMA writable_schema is not allowed/);

    assert.equal(
      (await tool.handle({ sql: "CREATE TABLE items (name TEXT)", write: true }, ctx)).ok,
      true,
    );
    const safePragma = await tool.handle({ sql: "PRAGMA table_info(items)" }, ctx);
    assert.equal(safePragma.ok, true);
    const output = safePragma.output as { rows: Array<{ name: string }>; count: number };
    assert.deepEqual(
      output.rows.map((row) => row.name),
      ["name"],
    );
  } finally {
    rmSync(dbRoot, { recursive: true, force: true });
  }
});
