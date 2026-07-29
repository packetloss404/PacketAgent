import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  GeneratedAppRuntimeModel,
  RuntimeRecordValue,
  RuntimeSchemaEntity,
} from "../generated-app-runtime.js";

export interface GeneratedAppRuntimeDatabasePathInput {
  appId: string;
  workspaceId: string;
  rootDir?: string;
  runtimeRoot?: string;
}

export interface GeneratedAppSqliteRuntimeInput extends GeneratedAppRuntimeDatabasePathInput {
  model: GeneratedAppRuntimeModel;
  dbPath?: string;
}

export interface GeneratedAppRuntimeApiRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

export interface GeneratedAppRuntimeApiResult {
  status: number;
  body: unknown;
}

type GeneratedRecord = Record<string, RuntimeRecordValue | undefined>;

interface RecordRow {
  id: string;
  body: string;
  archived: number;
  archived_at: string | null;
}

const VERSION_TABLE = "__schema_version";
const RECORDS_TABLE = "generated_records";
const SCHEMA_SIGNATURE_KEY = "schema_signature";

export function resolveGeneratedAppRuntimeDatabasePath(
  input: GeneratedAppRuntimeDatabasePathInput,
): string {
  const rootDir = path.resolve(input.rootDir ?? process.cwd());
  const runtimeRoot = path.resolve(
    input.runtimeRoot ?? path.join(rootDir, "data", "generated-app-runtimes"),
  );
  const workspaceSegment = safePathSegment(input.workspaceId, "workspace");
  const appSegment = safePathSegment(input.appId, "app");
  const dbPath = path.resolve(runtimeRoot, workspaceSegment, appSegment, "runtime.sqlite");
  assertInsidePath(runtimeRoot, dbPath);
  return dbPath;
}

export function openGeneratedAppSqliteRuntime(
  input: GeneratedAppSqliteRuntimeInput,
): GeneratedAppSqliteRuntime {
  const dbPath = input.dbPath ?? resolveGeneratedAppRuntimeDatabasePath(input);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const runtime = new GeneratedAppSqliteRuntime(db, dbPath, input.model);
  runtime.initialize();
  return runtime;
}

export function generatedAppRuntimeSchemaSignature(model: GeneratedAppRuntimeModel): string {
  const schemaShape = {
    primaryEntity: model.primaryEntity,
    schema: model.schema.map((entity) => ({
      name: entity.name,
      fields: entity.fields.map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required,
      })),
      requiredFields: entity.requiredFields,
      editableFields: entity.editableFields,
    })),
  };
  return createHash("sha256").update(JSON.stringify(schemaShape)).digest("hex");
}

export class GeneratedAppSqliteRuntime {
  constructor(
    private readonly db: DatabaseSync,
    readonly dbPath: string,
    private readonly model: GeneratedAppRuntimeModel,
  ) {}

  initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${RECORDS_TABLE} (
        entity TEXT NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entity, id)
      );
      CREATE INDEX IF NOT EXISTS generated_records_entity_active_idx
        ON ${RECORDS_TABLE} (entity, archived, updated_at);
    `);

    const desiredSignature = generatedAppRuntimeSchemaSignature(this.model);
    const existingSignature = this.getVersion(SCHEMA_SIGNATURE_KEY);
    if (existingSignature !== desiredSignature) {
      this.db.prepare(`DELETE FROM ${RECORDS_TABLE}`).run();
      this.setVersion(SCHEMA_SIGNATURE_KEY, desiredSignature);
      this.seedInitialData();
      return;
    }

    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${RECORDS_TABLE}`).get() as
      | { count: number }
      | undefined;
    if ((row?.count ?? 0) === 0) this.seedInitialData();
  }

  handleRequest(request: GeneratedAppRuntimeApiRequest): GeneratedAppRuntimeApiResult {
    const entity = this.entityForPath(request.path);
    if (!entity) {
      return { status: 404, body: { error: "No generated entity route matched." } };
    }

    const method = request.method.toUpperCase();
    const id = recordIdForPath(request.path, entity);

    if (method === "GET" || method === "HEAD") {
      if (!id) return { status: 200, body: this.listRecords(entity) };
      return { status: 200, body: this.findRecord(entity, id) ?? null };
    }

    if (method === "POST") return this.createRecord(entity, cleanBody(request.body));
    if ((method === "PATCH" || method === "PUT") && id)
      return this.updateRecord(entity, id, cleanBody(request.body));
    if (method === "DELETE" && id) return this.archiveRecord(entity, id);

    return { status: 405, body: { error: "Unsupported generated API method." } };
  }

  close(): void {
    this.db.close();
  }

  private entityForPath(requestPath: string): RuntimeSchemaEntity | undefined {
    const normalizedPath = normalizeLookup(requestPath);
    if (!normalizedPath) {
      return (
        this.model.schema.find((entity) => entity.name === this.model.primaryEntity) ??
        this.model.schema[0]
      );
    }
    return this.model.schema.find((entity) => {
      const normalizedEntity = normalizeLookup(entity.name);
      return (
        normalizedPath.includes(normalizedEntity) || normalizedPath.includes(`${normalizedEntity}s`)
      );
    });
  }

  private listRecords(entity: RuntimeSchemaEntity): GeneratedRecord[] {
    const rows = this.db
      .prepare(
        `
      SELECT id, body, archived, archived_at
      FROM ${RECORDS_TABLE}
      WHERE entity = ? AND archived = 0
      ORDER BY created_at ASC
    `,
      )
      .all(entity.name) as unknown as RecordRow[];
    return rows.map(recordFromRow);
  }

  private findRecord(entity: RuntimeSchemaEntity, id: string): GeneratedRecord | null {
    const row = this.db
      .prepare(
        `
      SELECT id, body, archived, archived_at
      FROM ${RECORDS_TABLE}
      WHERE entity = ? AND id = ? AND archived = 0
    `,
      )
      .get(entity.name, id) as RecordRow | undefined;
    return row ? recordFromRow(row) : null;
  }

  private createRecord(
    entity: RuntimeSchemaEntity,
    body: Record<string, unknown>,
  ): GeneratedAppRuntimeApiResult {
    const missingFields = missingRequiredFields(entity, body);
    if (missingFields.length > 0) {
      return { status: 400, body: { error: "Missing required fields.", missingFields } };
    }
    const id = String(body.id ?? nextRecordId(entity.name));
    const record = sanitizeRecord({ id, ...body, archived: false });
    this.upsertRecord(entity.name, id, record, false, null);
    return { status: 201, body: record };
  }

  private updateRecord(
    entity: RuntimeSchemaEntity,
    id: string,
    body: Record<string, unknown>,
  ): GeneratedAppRuntimeApiResult {
    const existing = this.findRecord(entity, id);
    if (!existing) return { status: 404, body: { error: "Record not found." } };
    const record = sanitizeRecord({ ...existing, ...body, id });
    this.upsertRecord(entity.name, id, record, false, null);
    return { status: 200, body: record };
  }

  private archiveRecord(entity: RuntimeSchemaEntity, id: string): GeneratedAppRuntimeApiResult {
    const existing = this.findRecord(entity, id);
    if (!existing) return { status: 404, body: { error: "Record not found." } };
    const archivedAt = new Date().toISOString();
    const record = sanitizeRecord({ ...existing, archived: true, archivedAt });
    this.upsertRecord(entity.name, id, record, true, archivedAt);
    return { status: 200, body: { ok: true, archivedId: id } };
  }

  private upsertRecord(
    entity: string,
    id: string,
    record: GeneratedRecord,
    archived: boolean,
    archivedAt: string | null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO ${RECORDS_TABLE} (entity, id, body, archived, archived_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity, id) DO UPDATE SET
        body = excluded.body,
        archived = excluded.archived,
        archived_at = excluded.archived_at,
        updated_at = excluded.updated_at
    `,
      )
      .run(entity, id, JSON.stringify(record), archived ? 1 : 0, archivedAt, now, now);
  }

  private seedInitialData(): void {
    for (const entity of this.model.schema) {
      const records = this.model.seedData[entity.name] ?? [];
      for (const seed of records) {
        const id = String(seed.id ?? nextRecordId(entity.name));
        this.upsertRecord(
          entity.name,
          id,
          sanitizeRecord({ id, ...seed, archived: false }),
          false,
          null,
        );
      }
    }
  }

  private getVersion(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM ${VERSION_TABLE} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setVersion(key: string, value: string): void {
    this.db
      .prepare(
        `
      INSERT INTO ${VERSION_TABLE} (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
      )
      .run(key, value, new Date().toISOString());
  }
}

function recordFromRow(row: RecordRow): GeneratedRecord {
  const parsed = JSON.parse(row.body) as GeneratedRecord;
  if (row.archived) {
    return { ...parsed, id: row.id, archived: true, archivedAt: row.archived_at ?? undefined };
  }
  return { ...parsed, id: row.id };
}

function missingRequiredFields(
  entity: RuntimeSchemaEntity,
  body: Record<string, unknown>,
): string[] {
  return entity.requiredFields
    .filter((field) => field !== "id")
    .filter((field) => body[field] === undefined || body[field] === null || body[field] === "");
}

function cleanBody(body: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body;
}

function sanitizeRecord(record: Record<string, unknown>): GeneratedRecord {
  const out: GeneratedRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    ) {
      out[key] = value;
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

function recordIdForPath(requestPath: string, entity: RuntimeSchemaEntity): string | undefined {
  const segments =
    requestPath.split("?")[0]?.split("#")[0]?.split("/").map(safeDecode).filter(Boolean) ?? [];
  const last = segments.at(-1);
  if (!last) return undefined;
  const normalizedLast = normalizeLookup(last);
  const normalizedEntity = normalizeLookup(entity.name);
  if (normalizedLast === normalizedEntity || normalizedLast === `${normalizedEntity}s`)
    return undefined;
  return last;
}

function nextRecordId(entityName: string): string {
  return `${entityName.slice(0, 4).toLowerCase()}_${randomUUID().slice(0, 8)}`;
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safePathSegment(value: string, fallback: string): string {
  const segment =
    value
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback;
  if (segment === "." || segment === ".." || segment.includes("..")) {
    throw new Error(`unsafe generated app runtime path segment: ${value}`);
  }
  return segment;
}

function assertInsidePath(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`generated app runtime database path escapes runtime root: ${child}`);
}
