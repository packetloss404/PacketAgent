import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOST = process.env.HOST?.trim() || "0.0.0.0";
const PORT = boundedInteger(process.env.PORT, 8080, 1, 65535);
const STATIC_ROOT = path.resolve(
  process.env.PACKETAGENT_GENERATED_APP_STATIC_ROOT || "/app/static",
);
const DATA_ROOT = path.resolve(process.env.PACKETAGENT_GENERATED_APP_DATA_ROOT || "/app/data");
const CONFIG_PATH = path.resolve(
  process.env.PACKETAGENT_GENERATED_APP_CONFIG_PATH || "/app/runtime/runtime-config.json",
);
const MODEL_PATH = path.resolve(
  process.env.PACKETAGENT_GENERATED_APP_MODEL_PATH || "/app/runtime/runtime-model.json",
);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANIFEST_REFERENCES = 4096;
const RECORDS_TABLE = "generated_records";
const VERSION_TABLE = "__schema_version";
const SCHEMA_SIGNATURE_KEY = "schema_signature";
const SCHEMA_CHANGE_POLICY = "reset-and-reseed";

const config = readJson(CONFIG_PATH, 256 * 1024);
const model = readJson(MODEL_PATH, 2 * 1024 * 1024);
assertRuntimeConfig(config);
assertRuntimeModel(model);
const staticVerification = verifyViteStaticOutput(STATIC_ROOT);
const databasePath = path.join(DATA_ROOT, "runtime.sqlite");
const database = new DatabaseSync(databasePath);
initializeDatabase(database, model);

const server = createServer(async (request, response) => {
  try {
    await routeRequest(request, response);
  } catch (error) {
    const status =
      error instanceof HttpError && Number.isSafeInteger(error.status) ? error.status : 500;
    const message = status >= 500 ? "Generated app runtime request failed." : String(error.message);
    sendJson(response, status, { error: message });
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, HOST, () => {
  process.stdout.write(
    `${JSON.stringify({
      event: "generated_app_runtime_started",
      appId: config.appId,
      checkpointId: config.checkpointId,
      host: HOST,
      port: PORT,
      staticFiles: staticVerification.files,
    })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      database.close();
      process.exit(0);
    });
  });
}

async function routeRequest(request, response) {
  const url = new URL(request.url || "/", "http://generated-app.local");
  if (url.pathname === "/health/live") {
    sendJson(response, 200, { status: "live" });
    return;
  }
  if (url.pathname === "/health/ready") {
    database.prepare("SELECT 1").get();
    sendJson(response, 200, {
      status: "ready",
      appId: config.appId,
      checkpointId: config.checkpointId,
      schemaChangePolicy: SCHEMA_CHANGE_POLICY,
      staticFiles: staticVerification.files,
    });
    return;
  }
  if (url.pathname === "/meta") {
    sendJson(response, 200, {
      runtime: "packetagent-generated-app-standalone",
      appId: config.appId,
      workspaceId: config.workspaceId,
      checkpointId: config.checkpointId,
      schemaChangePolicy: SCHEMA_CHANGE_POLICY,
      schemaEntities: model.schema.map((entity) => entity.name),
    });
    return;
  }

  const apiMatch = url.pathname.match(/^\/api\/app\/generated-apps\/([^/]+)\/api(?:\/(.*))?$/);
  if (apiMatch) {
    const requestedAppId = safeDecode(apiMatch[1]);
    if (requestedAppId !== config.appId) {
      sendJson(response, 404, { error: "Generated app route does not match this package." });
      return;
    }
    const body = await readRequestBody(request);
    const result = handleApiRequest(database, model, {
      method: request.method || "GET",
      path: apiMatch[2] || "",
      body,
    });
    sendJson(response, result.status, result.body, request.method === "HEAD");
    return;
  }

  if (!["GET", "HEAD"].includes(request.method || "GET")) {
    sendJson(response, 405, { error: "Unsupported generated app runtime method." });
    return;
  }
  serveStatic(response, url.pathname, request.method === "HEAD");
}

function initializeDatabase(db, runtimeModel) {
  db.exec(`
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

  const desiredSignature = schemaSignature(runtimeModel);
  const existingSignature = db
    .prepare(`SELECT value FROM ${VERSION_TABLE} WHERE key = ?`)
    .get(SCHEMA_SIGNATURE_KEY)?.value;
  if (existingSignature !== desiredSignature) {
    db.prepare(`DELETE FROM ${RECORDS_TABLE}`).run();
    db.prepare(
      `
      INSERT INTO ${VERSION_TABLE} (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    ).run(SCHEMA_SIGNATURE_KEY, desiredSignature, new Date().toISOString());
  }
  const count = db.prepare(`SELECT COUNT(*) AS count FROM ${RECORDS_TABLE}`).get()?.count ?? 0;
  if (count === 0) seedDatabase(db, runtimeModel);
}

function schemaSignature(runtimeModel) {
  const shape = {
    primaryEntity: runtimeModel.primaryEntity,
    schema: runtimeModel.schema.map((entity) => ({
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
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

function seedDatabase(db, runtimeModel) {
  for (const entity of runtimeModel.schema) {
    for (const seed of runtimeModel.seedData[entity.name] || []) {
      const id = String(seed.id || nextRecordId(entity.name));
      upsertRecord(db, entity.name, id, sanitizeRecord({ id, ...seed, archived: false }), false);
    }
  }
}

function handleApiRequest(db, runtimeModel, request) {
  const entity = entityForPath(runtimeModel, request.path);
  if (!entity) return { status: 404, body: { error: "No generated entity route matched." } };
  const method = request.method.toUpperCase();
  const id = recordIdForPath(request.path, entity);

  if (method === "GET" || method === "HEAD") {
    if (!id) {
      const rows = db
        .prepare(
          `
        SELECT id, body, archived, archived_at
        FROM ${RECORDS_TABLE}
        WHERE entity = ? AND archived = 0
        ORDER BY created_at ASC
      `,
        )
        .all(entity.name);
      return { status: 200, body: rows.map(recordFromRow) };
    }
    const row = db
      .prepare(
        `
      SELECT id, body, archived, archived_at
      FROM ${RECORDS_TABLE}
      WHERE entity = ? AND id = ? AND archived = 0
    `,
      )
      .get(entity.name, id);
    return { status: 200, body: row ? recordFromRow(row) : null };
  }

  if (method === "POST") {
    const body = cleanBody(request.body);
    const missingFields = missingRequiredFields(entity, body);
    if (missingFields.length) {
      return { status: 400, body: { error: "Missing required fields.", missingFields } };
    }
    const id = String(body.id || nextRecordId(entity.name));
    const record = sanitizeRecord({ id, ...body, archived: false });
    upsertRecord(db, entity.name, id, record, false);
    return { status: 201, body: record };
  }

  if ((method === "PATCH" || method === "PUT") && id) {
    const existing = findRecord(db, entity.name, id);
    if (!existing) return { status: 404, body: { error: "Record not found." } };
    const record = sanitizeRecord({ ...existing, ...cleanBody(request.body), id });
    upsertRecord(db, entity.name, id, record, false);
    return { status: 200, body: record };
  }

  if (method === "DELETE" && id) {
    const existing = findRecord(db, entity.name, id);
    if (!existing) return { status: 404, body: { error: "Record not found." } };
    const archivedAt = new Date().toISOString();
    const record = sanitizeRecord({ ...existing, archived: true, archivedAt });
    upsertRecord(db, entity.name, id, record, true, archivedAt);
    return { status: 200, body: { ok: true, archivedId: id } };
  }

  return { status: 405, body: { error: "Unsupported generated API method." } };
}

function findRecord(db, entityName, id) {
  const row = db
    .prepare(
      `
    SELECT id, body, archived, archived_at
    FROM ${RECORDS_TABLE}
    WHERE entity = ? AND id = ? AND archived = 0
  `,
    )
    .get(entityName, id);
  return row ? recordFromRow(row) : null;
}

function upsertRecord(db, entityName, id, record, archived, archivedAt = null) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO ${RECORDS_TABLE} (entity, id, body, archived, archived_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity, id) DO UPDATE SET
      body = excluded.body,
      archived = excluded.archived,
      archived_at = excluded.archived_at,
      updated_at = excluded.updated_at
  `,
  ).run(entityName, id, JSON.stringify(record), archived ? 1 : 0, archivedAt, now, now);
}

function entityForPath(runtimeModel, requestPath) {
  const normalizedPath = normalizeLookup(requestPath);
  if (!normalizedPath) {
    return (
      runtimeModel.schema.find((entity) => entity.name === runtimeModel.primaryEntity) ||
      runtimeModel.schema[0]
    );
  }
  return runtimeModel.schema.find((entity) => {
    const normalizedEntity = normalizeLookup(entity.name);
    return (
      normalizedPath.includes(normalizedEntity) || normalizedPath.includes(`${normalizedEntity}s`)
    );
  });
}

function recordIdForPath(requestPath, entity) {
  const segments = requestPath
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .map(safeDecode)
    .filter(Boolean);
  const last = segments.at(-1);
  if (!last) return undefined;
  const normalizedLast = normalizeLookup(last);
  const normalizedEntity = normalizeLookup(entity.name);
  if (normalizedLast === normalizedEntity || normalizedLast === `${normalizedEntity}s`)
    return undefined;
  return last;
}

function missingRequiredFields(entity, body) {
  return entity.requiredFields
    .filter((field) => field !== "id")
    .filter((field) => body[field] === undefined || body[field] === null || body[field] === "");
}

function recordFromRow(row) {
  const parsed = JSON.parse(row.body);
  return row.archived
    ? { ...parsed, id: row.id, archived: true, archivedAt: row.archived_at || undefined }
    : { ...parsed, id: row.id };
}

function sanitizeRecord(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
        ? value
        : JSON.stringify(value),
    ]),
  );
}

function cleanBody(body) {
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

async function readRequestBody(request) {
  if (["GET", "HEAD", "DELETE"].includes(request.method || "GET")) return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body exceeds 1 MiB.");
    chunks.push(chunk);
  }
  if (!size) return {};
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "Generated app API accepts application/json.");
  }
  try {
    return cleanBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function verifyViteStaticOutput(root) {
  const manifestPath = path.join(root, ".vite", "manifest.json");
  const manifest = readJson(manifestPath, MAX_MANIFEST_BYTES);
  const references = new Set(["index.html"]);
  const chunkReferences = [];
  for (const [key, chunk] of Object.entries(manifest)) {
    if (!chunk || typeof chunk !== "object" || typeof chunk.file !== "string") {
      throw new Error(`invalid Vite manifest chunk: ${key}`);
    }
    references.add(chunk.file);
    for (const field of ["css", "assets"]) {
      for (const value of Array.isArray(chunk[field]) ? chunk[field] : []) {
        if (typeof value !== "string") throw new Error(`invalid Vite manifest ${field}: ${key}`);
        references.add(value);
      }
    }
    for (const field of ["imports", "dynamicImports"]) {
      for (const value of Array.isArray(chunk[field]) ? chunk[field] : []) {
        if (typeof value !== "string") throw new Error(`invalid Vite manifest ${field}: ${key}`);
        chunkReferences.push({ key, field, value });
      }
    }
    if (references.size > MAX_MANIFEST_REFERENCES) {
      throw new Error("Vite manifest reference limit exceeded");
    }
  }
  if (references.size + chunkReferences.length > MAX_MANIFEST_REFERENCES) {
    throw new Error("Vite manifest reference limit exceeded");
  }
  for (const reference of chunkReferences) {
    if (!Object.hasOwn(manifest, reference.value)) {
      throw new Error(
        `Vite manifest ${reference.field} from ${reference.key} is missing chunk: ${reference.value}`,
      );
    }
  }
  for (const reference of references) {
    const target = safeStaticPath(root, reference);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new Error(`Vite output is missing referenced file: ${reference}`);
    }
  }
  if (!Object.values(manifest).some((chunk) => chunk?.isEntry === true)) {
    throw new Error("Vite output manifest has no entry chunk");
  }
  return { files: references.size };
}

function serveStatic(response, requestPath, headOnly) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    throw new HttpError(400, "Static asset path is not valid.");
  }
  const candidate = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let target = safeStaticPath(STATIC_ROOT, candidate);
  if (!existsSync(target) || !statSync(target).isFile()) {
    if (path.extname(candidate)) throw new HttpError(404, "Static asset not found.");
    target = safeStaticPath(STATIC_ROOT, "index.html");
  }
  const stats = statSync(target);
  response.writeHead(200, {
    "Cache-Control": target.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "Content-Length": String(stats.size),
    "Content-Type": contentType(target),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(headOnly ? undefined : readFileSync(target));
}

function safeStaticPath(root, value) {
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, "Static asset path escapes the generated app root.");
  }
  return target;
}

function readJson(filePath, maxBytes) {
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > maxBytes)
    throw new Error(`invalid runtime file: ${filePath}`);
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertRuntimeConfig(value) {
  for (const field of ["workspaceId", "appId", "checkpointId"]) {
    if (typeof value?.[field] !== "string" || !value[field].trim()) {
      throw new Error(`runtime config is missing ${field}`);
    }
  }
  if (value.schemaChangePolicy !== SCHEMA_CHANGE_POLICY) {
    throw new Error(`runtime config must declare ${SCHEMA_CHANGE_POLICY} schema changes`);
  }
}

function assertRuntimeModel(value) {
  if (
    !value ||
    typeof value.primaryEntity !== "string" ||
    !Array.isArray(value.schema) ||
    value.schema.length === 0 ||
    !value.seedData ||
    typeof value.seedData !== "object"
  ) {
    throw new Error("runtime model is invalid");
  }
}

function sendJson(response, status, body, headOnly = false) {
  const content = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(content.length),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(headOnly ? undefined : content);
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extension] || "application/octet-stream"
  );
}

function normalizeLookup(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function nextRecordId(entityName) {
  return `${entityName.slice(0, 4).toLowerCase()}_${randomUUID().slice(0, 8)}`;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
