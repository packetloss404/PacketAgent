import { createHash } from "node:crypto";
import type {
  ApiRouteStub,
  AppDraft,
  DataSchemaDraft,
  FieldSchemaDraft,
  GeneratedAppSourceArtifactBundle,
  GeneratedAppSourceFile,
  GeneratedAppSourceFileKind,
  RouteAccess,
} from "./types.js";
import {
  buildGeneratedPageData,
  editableFieldNames,
  requiredFieldNames,
} from "./draft-helpers.js";
import { appSlug, escapeHtml, generatedArtifactCopy } from "./text-helpers.js";

export function generateAppSourceArtifactBundle(draft: AppDraft): GeneratedAppSourceArtifactBundle {
  const slug = appSlug(draft.appName);
  const pages = buildGeneratedPageData(draft);
  const apiRoutes = draft.apiRouteStubs.map((route) => ({
    method: route.method,
    path: route.path,
    access: route.access,
    authRequired: route.access !== "public",
    requiredRole: route.access === "admin" ? ("admin" as const) : undefined,
    purpose: route.purpose,
    requestBody: route.requestBody,
    responseShape: route.responseShape,
  }));
  const dataContracts = {
    database: draft.dataSchema.database,
    entities: draft.dataSchema.entities.map((entityDraft) => ({
      name: entityDraft.name,
      primaryKey: entityDraft.primaryKey,
      requiredFields: requiredFieldNames(entityDraft),
      editableFields: editableFieldNames(entityDraft),
      fields: entityDraft.fields,
      indexes: entityDraft.indexes,
      relations: entityDraft.relations,
    })),
    notes: draft.dataSchema.notes,
  };
  const routeSummary = {
    publicRoutes: draft.auth.publicRoutes,
    privateRoutes: draft.auth.privateRoutes,
    adminRoutes: draft.auth.roleRoutes.flatMap((entry) => entry.routes),
    decisions: draft.auth.decisions.map(generatedArtifactCopy),
  };

  const files = [
    sourceFile("package.json", "manifest", renderGeneratedPackageJson(slug)),
    sourceFile("index.html", "config", renderGeneratedIndexHtml(draft.appName)),
    sourceFile("tsconfig.json", "config", renderGeneratedTsConfig()),
    sourceFile("vite.config.ts", "config", renderGeneratedViteConfig()),
    sourceFile("src/main.tsx", "source", renderGeneratedMainTsx()),
    sourceFile("src/App.tsx", "source", renderGeneratedAppTsx(draft, pages, slug)),
    sourceFile("src/styles.css", "source", renderGeneratedStylesCss()),
    sourceFile("src/routes/page-data.ts", "route-data", renderGeneratedPageDataTs(pages, routeSummary)),
    sourceFile("src/api/generated-api.ts", "api", renderGeneratedApiTs(apiRoutes, dataContracts)),
    sourceFile("src/data/seed-data.json", "seed-data", JSON.stringify(draft.seedData, null, 2)),
    sourceFile("README.md", "documentation", renderGeneratedReadme(draft, pages, apiRoutes)),
  ];

  return {
    appName: draft.appName,
    appSlug: slug,
    templateId: draft.templateId,
    entrypoint: "src/App.tsx",
    files,
  };
}

function sourceFile(path: string, kind: GeneratedAppSourceFileKind, contents: string): GeneratedAppSourceFile {
  const normalized = normalizeGeneratedFileContents(contents);
  return {
    path,
    kind,
    contents: normalized,
    sizeBytes: Buffer.byteLength(normalized, "utf8"),
    checksum: createHash("sha256").update(normalized).digest("hex"),
  };
}

function normalizeGeneratedFileContents(contents: string): string {
  return `${contents.replace(/\r\n/g, "\n").replace(/\s+$/g, "")}\n`;
}

function renderGeneratedPackageJson(slug: string): string {
  return JSON.stringify({
    name: slug,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "vite build",
      preview: "vite preview",
    },
    dependencies: {
      "@vitejs/plugin-react": "^5.0.2",
      vite: "^7.1.3",
      typescript: "^5.9.2",
      react: "^19.1.1",
      "react-dom": "^19.1.1",
    },
    devDependencies: {},
  }, null, 2);
}

function renderGeneratedIndexHtml(appName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(appName)}</title>
    <script src="https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-wasm.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;
}

function renderGeneratedTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      useDefineForClassFields: true,
      lib: ["DOM", "DOM.Iterable", "ES2022"],
      allowJs: false,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      strict: true,
      forceConsistentCasingInFileNames: true,
      module: "ESNext",
      moduleResolution: "Bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: "react-jsx",
    },
    include: ["src"],
    references: [],
  }, null, 2);
}

function renderGeneratedViteConfig(): string {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});`;
}

function renderGeneratedMainTsx(): string {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);`;
}

function renderGeneratedAppTsx(
  draft: AppDraft,
  pages: ReturnType<typeof buildGeneratedPageData>,
  slug: string,
): string {
  const primaryEntity = draft.dataSchema.entities[0]?.name ?? "record";
  const appName = JSON.stringify(draft.appName);
  const summary = JSON.stringify(draft.summary);
  const primaryEntityLiteral = JSON.stringify(primaryEntity);
  const appIdLiteral = JSON.stringify(slug);
  const pageCount = pages.length;

  return `import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRoutes, dataContracts } from "./api/generated-api";
import seedData from "./data/seed-data.json";
import { pages, routeAccess } from "./routes/page-data";
import "./styles.css";

type FieldType = "uuid" | "string" | "text" | "number" | "boolean" | "date" | "datetime" | "enum";
type FieldDef = {
  name: string;
  type: FieldType;
  required: boolean;
  enumValues?: string[];
  references?: string;
};
type EntityContract = {
  name: string;
  primaryKey: string;
  requiredFields: string[];
  editableFields: string[];
  fields: FieldDef[];
};
type Record = { [key: string]: string | number | boolean | null };
type SeedData = { [entity: string]: Record[] };
type SqlValue = string | number | null;
type SqlStatement = {
  bind: (values: SqlValue[]) => void;
  step: () => boolean;
  getAsObject: () => { [column: string]: SqlValue };
  free: () => void;
  run: (values?: SqlValue[]) => void;
};
type SqlDatabase = {
  run: (sql: string, params?: SqlValue[]) => void;
  exec: (sql: string) => Array<{ columns: string[]; values: SqlValue[][] }>;
  prepare: (sql: string) => SqlStatement;
  export: () => Uint8Array;
  close: () => void;
};
type SqlJsStatic = {
  Database: new (data?: Uint8Array) => SqlDatabase;
};
type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
declare global {
  interface Window {
    initSqlJs?: InitSqlJs;
  }
}

const appName = ${appName};
const summary = ${summary};
const primaryEntity = ${primaryEntityLiteral};
const appId = ${appIdLiteral};
const entities = dataContracts.entities as EntityContract[];
const typedSeedData = seedData as SeedData;

// Include a fingerprint of the schema in the storage key so that when the
// user iterates and changes entity fields, the next load doesn't silently
// reuse an old SQLite file whose tables are missing the new columns.
// (CREATE TABLE IF NOT EXISTS would otherwise be a no-op and inserts would
// fail or lose data.) Bumping the schema starts a clean DB; that's the
// right tradeoff for an unbundled preview where migrations aren't worth
// emitting from the LLM.
const schemaFingerprint = (() => {
  const stable = entities.map((e) => ({
    name: e.name,
    fields: (e.fields ?? []).map((f) => ({ name: f.name, type: f.type, enum: f.enumValues ?? null })),
  }));
  const text = JSON.stringify(stable);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).slice(0, 8);
})();
const storageKey = \`packetagent_app_\${appId}_db_\${schemaFingerprint}\`;

function sqlTypeForField(field: FieldDef): string {
  if (field.type === "number") return "REAL";
  if (field.type === "boolean") return "INTEGER";
  if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
    const allowed = field.enumValues.map((value) => \`'\${value.replace(/'/g, "''")}'\`).join(", ");
    return \`TEXT CHECK(\${quoteIdent(field.name)} IN (\${allowed}))\`;
  }
  return "TEXT";
}

function quoteIdent(name: string): string {
  return \`"\${name.replace(/"/g, '""')}"\`;
}

function buildCreateTableSql(entity: EntityContract): string {
  const columnDefs = entity.fields.map((field) => {
    const parts: string[] = [quoteIdent(field.name), sqlTypeForField(field)];
    if (field.name === entity.primaryKey) parts.push("PRIMARY KEY");
    if (field.required && field.name !== entity.primaryKey) parts.push("NOT NULL");
    return parts.join(" ");
  });
  return \`CREATE TABLE IF NOT EXISTS \${quoteIdent(entity.name)} (\${columnDefs.join(", ")});\`;
}

function toSqlValue(field: FieldDef, raw: Record[keyof Record]): SqlValue {
  if (raw === null || raw === undefined) return null;
  if (field.type === "boolean") return raw ? 1 : 0;
  if (field.type === "number") {
    const numeric = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") return raw;
  return String(raw);
}

function fromSqlValue(field: FieldDef, raw: SqlValue): Record[keyof Record] {
  if (raw === null || raw === undefined) return null;
  if (field.type === "boolean") return raw === 1 || raw === "1" || raw === "true";
  if (field.type === "number") {
    const numeric = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return typeof raw === "number" ? raw : String(raw);
}

function insertRow(db: SqlDatabase, entity: EntityContract, row: Record): void {
  const columns = entity.fields.map((field) => quoteIdent(field.name)).join(", ");
  const placeholders = entity.fields.map(() => "?").join(", ");
  const values = entity.fields.map((field) => toSqlValue(field, row[field.name] ?? null));
  db.run(\`INSERT OR REPLACE INTO \${quoteIdent(entity.name)} (\${columns}) VALUES (\${placeholders});\`, values);
}

function selectAll(db: SqlDatabase, entity: EntityContract): Record[] {
  const stmt = db.prepare(\`SELECT * FROM \${quoteIdent(entity.name)};\`);
  const rows: Record[] = [];
  try {
    while (stmt.step()) {
      const raw = stmt.getAsObject();
      const row: Record = {};
      entity.fields.forEach((field) => {
        row[field.name] = fromSqlValue(field, raw[field.name] ?? null);
      });
      rows.push(row);
    }
  } finally {
    stmt.free();
  }
  return rows;
}

function deleteRow(db: SqlDatabase, entity: EntityContract, id: SqlValue): void {
  db.run(\`DELETE FROM \${quoteIdent(entity.name)} WHERE \${quoteIdent(entity.primaryKey)} = ?;\`, [id]);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function base64ToUint8(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function persistDb(db: SqlDatabase): void {
  try {
    const data = db.export();
    window.localStorage.setItem(storageKey, uint8ToBase64(data));
  } catch (error) {
    console.warn("Failed to persist generated app database:", error);
  }
}

function seedDatabase(db: SqlDatabase): void {
  entities.forEach((entity) => {
    db.run(buildCreateTableSql(entity));
  });
  entities.forEach((entity) => {
    const rows = typedSeedData[entity.name] ?? [];
    rows.forEach((row) => insertRow(db, entity, row as Record));
  });
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (typeof window === "undefined" || !window.initSqlJs) {
    throw new Error("sql.js loader is not available on window.initSqlJs");
  }
  return window.initSqlJs({
    locateFile: (file: string) => \`https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/\${file}\`,
  });
}

type DbStatus = "loading" | "ready" | "error";

type UseLocalDbResult = {
  status: DbStatus;
  error: string | null;
  data: SeedData;
  insert: (entityName: string, row: Record) => void;
  remove: (entityName: string, id: string | number) => void;
  reset: () => void;
};

function useLocalDb(): UseLocalDbResult {
  const [db, setDb] = useState<SqlDatabase | null>(null);
  const [status, setStatus] = useState<DbStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SeedData>(() => {
    const initial: SeedData = {};
    entities.forEach((entity) => {
      initial[entity.name] = (typedSeedData[entity.name] ?? []).map((row) => ({ ...row }));
    });
    return initial;
  });

  const refresh = useCallback((instance: SqlDatabase) => {
    const next: SeedData = {};
    entities.forEach((entity) => {
      next[entity.name] = selectAll(instance, entity);
    });
    setData(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let instance: SqlDatabase | null = null;
    (async () => {
      try {
        const SQL = await loadSqlJs();
        let opened: SqlDatabase | null = null;
        const stored = window.localStorage.getItem(storageKey);
        if (stored) {
          try {
            opened = new SQL.Database(base64ToUint8(stored));
            entities.forEach((entity) => opened?.run(buildCreateTableSql(entity)));
          } catch (loadError) {
            console.warn("Stored generated app database was corrupted; reseeding.", loadError);
            opened = null;
          }
        }
        if (!opened) {
          opened = new SQL.Database();
          seedDatabase(opened);
          persistDb(opened);
        }
        if (cancelled) {
          opened.close();
          return;
        }
        instance = opened;
        setDb(opened);
        refresh(opened);
        setStatus("ready");
      } catch (loadError) {
        if (cancelled) return;
        console.error("Failed to initialize local SQLite database:", loadError);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      if (instance) instance.close();
    };
  }, [refresh]);

  const insert = useCallback((entityName: string, row: Record) => {
    if (!db) return;
    const entity = entities.find((entry) => entry.name === entityName);
    if (!entity) return;
    insertRow(db, entity, row);
    persistDb(db);
    refresh(db);
  }, [db, refresh]);

  const remove = useCallback((entityName: string, id: string | number) => {
    if (!db) return;
    const entity = entities.find((entry) => entry.name === entityName);
    if (!entity) return;
    deleteRow(db, entity, id);
    persistDb(db);
    refresh(db);
  }, [db, refresh]);

  const reset = useCallback(() => {
    if (!db) return;
    entities.forEach((entity) => {
      db.run(\`DELETE FROM \${quoteIdent(entity.name)};\`);
    });
    seedDatabase(db);
    persistDb(db);
    refresh(db);
  }, [db, refresh]);

  return { status, error, data, insert, remove, reset };
}

function generateRecordId(entityName: string): string {
  const prefix = entityName.slice(0, 3).toLowerCase() || "row";
  const random = Math.random().toString(36).slice(2, 8);
  const stamp = Date.now().toString(36);
  return \`\${prefix}_\${stamp}\${random}\`;
}

function emptyRowForEntity(entity: EntityContract): { [key: string]: string } {
  const initial: { [key: string]: string } = {};
  entity.fields.forEach((field) => {
    if (field.name === entity.primaryKey) return;
    if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
      initial[field.name] = field.enumValues[0] ?? "";
    } else if (field.type === "boolean") {
      initial[field.name] = "false";
    } else {
      initial[field.name] = "";
    }
  });
  return initial;
}

function coerceFormValue(field: FieldDef, value: string): Record[keyof Record] {
  if (value === "" && !field.required) return null;
  if (field.type === "number") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (field.type === "boolean") return value === "true";
  return value;
}

function formatCellValue(value: Record[keyof Record]): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function EntityWorkbench({
  entity,
  rows,
  onCreate,
  onRemove,
}: {
  entity: EntityContract;
  rows: Record[];
  onCreate: (row: Record) => void;
  onRemove: (id: string | number) => void;
}) {
  const editableFields = useMemo(
    () => entity.fields.filter((field) => entity.editableFields.includes(field.name)),
    [entity],
  );
  const [draft, setDraft] = useState<{ [key: string]: string }>(() => emptyRowForEntity(entity));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleChange = (fieldName: string, value: string) => {
    setDraft((current) => ({ ...current, [fieldName]: value }));
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(null);
    const missing = entity.requiredFields.filter((name) => {
      if (name === entity.primaryKey) return false;
      const value = draft[name];
      return value === undefined || value === "";
    });
    if (missing.length > 0) {
      setErrorMessage(\`Missing required fields: \${missing.join(", ")}\`);
      return;
    }
    const row: Record = { [entity.primaryKey]: generateRecordId(entity.name) };
    entity.fields.forEach((field) => {
      if (field.name === entity.primaryKey) return;
      if (Object.prototype.hasOwnProperty.call(draft, field.name)) {
        row[field.name] = coerceFormValue(field, draft[field.name] ?? "");
      }
    });
    onCreate(row);
    setDraft(emptyRowForEntity(entity));
  };

  return (
    <article className="entity-workbench">
      <header>
        <h3>{entity.name}</h3>
        <span className="row-count">{rows.length} {rows.length === 1 ? "record" : "records"}</span>
      </header>

      <form onSubmit={handleSubmit} className="entity-form" aria-label={\`Create \${entity.name}\`}>
        <div className="entity-form-grid">
          {editableFields.map((field) => {
            const inputId = \`field-\${entity.name}-\${field.name}\`;
            const value = draft[field.name] ?? "";
            if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
              return (
                <label key={field.name} htmlFor={inputId}>
                  <span>{field.name}{field.required ? " *" : ""}</span>
                  <select
                    id={inputId}
                    value={value}
                    onChange={(event) => handleChange(field.name, event.target.value)}
                    required={field.required}
                  >
                    {field.enumValues.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
              );
            }
            if (field.type === "boolean") {
              return (
                <label key={field.name} htmlFor={inputId}>
                  <span>{field.name}{field.required ? " *" : ""}</span>
                  <select
                    id={inputId}
                    value={value}
                    onChange={(event) => handleChange(field.name, event.target.value)}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </label>
              );
            }
            if (field.type === "text") {
              return (
                <label key={field.name} htmlFor={inputId} className="entity-form-wide">
                  <span>{field.name}{field.required ? " *" : ""}</span>
                  <textarea
                    id={inputId}
                    value={value}
                    onChange={(event) => handleChange(field.name, event.target.value)}
                    rows={3}
                    required={field.required}
                  />
                </label>
              );
            }
            if (field.type === "date") {
              return (
                <label key={field.name} htmlFor={inputId}>
                  <span>{field.name}{field.required ? " *" : ""}</span>
                  <input
                    id={inputId}
                    type="date"
                    value={value}
                    onChange={(event) => handleChange(field.name, event.target.value)}
                    required={field.required}
                  />
                </label>
              );
            }
            if (field.type === "datetime") {
              return (
                <label key={field.name} htmlFor={inputId}>
                  <span>{field.name}{field.required ? " *" : ""}</span>
                  <input
                    id={inputId}
                    type="datetime-local"
                    value={value}
                    onChange={(event) => handleChange(field.name, event.target.value)}
                    required={field.required}
                  />
                </label>
              );
            }
            if (field.type === "number") {
              return (
                <label key={field.name} htmlFor={inputId}>
                  <span>{field.name}{field.required ? " *" : ""}</span>
                  <input
                    id={inputId}
                    type="number"
                    value={value}
                    onChange={(event) => handleChange(field.name, event.target.value)}
                    required={field.required}
                  />
                </label>
              );
            }
            return (
              <label key={field.name} htmlFor={inputId}>
                <span>{field.name}{field.required ? " *" : ""}</span>
                <input
                  id={inputId}
                  type="text"
                  value={value}
                  onChange={(event) => handleChange(field.name, event.target.value)}
                  required={field.required}
                />
              </label>
            );
          })}
        </div>
        {errorMessage ? <p className="entity-form-error" role="alert">{errorMessage}</p> : null}
        <div className="entity-form-actions">
          <button type="submit">Save {entity.name}</button>
        </div>
      </form>

      <div className="entity-table-wrap">
        <table className="entity-table">
          <thead>
            <tr>
              {entity.fields.map((field) => (
                <th key={field.name}>{field.name}</th>
              ))}
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={entity.fields.length + 1} className="entity-table-empty">No records yet.</td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const idValue = row[entity.primaryKey];
                const rowKey = idValue !== null && idValue !== undefined ? String(idValue) : \`row-\${index}\`;
                return (
                  <tr key={rowKey}>
                    {entity.fields.map((field) => (
                      <td key={field.name}>{formatCellValue(row[field.name] ?? null)}</td>
                    ))}
                    <td>
                      {idValue !== null && idValue !== undefined ? (
                        <button
                          type="button"
                          className="entity-row-remove"
                          onClick={() => onRemove(idValue as string | number)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}

export default function App() {
  const { status, error, data, insert, remove, reset } = useLocalDb();
  const totalRecords = useMemo(
    () => entities.reduce((sum, entity) => sum + (data[entity.name]?.length ?? 0), 0),
    [data],
  );

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <h1>{appName}</h1>
          <p>{summary}</p>
        </div>
        <dl className="hero-stats" aria-label="App summary">
          <div>
            <dt>Pages</dt>
            <dd>${pageCount}</dd>
          </div>
          <div>
            <dt>API routes</dt>
            <dd>{apiRoutes.length}</dd>
          </div>
          <div>
            <dt>Primary data</dt>
            <dd>{primaryEntity}</dd>
          </div>
        </dl>
      </header>

      <section className="layout-grid" aria-label="Generated app workspace">
        <nav className="panel route-nav" aria-label="Routes">
          <h2>Pages</h2>
          {pages.map((page) => (
            <a key={page.route} href={page.route}>
              <span>{page.name}</span>
              <small>{page.route}</small>
            </a>
          ))}
        </nav>

        <section className="panel page-list">
          <h2>Route Plan</h2>
          <div className="cards">
            {pages.map((page) => (
              <article key={page.route} className="page-card">
                <div>
                  <p className="access">{page.access}</p>
                  <h3>{page.name}</h3>
                </div>
                <p>{page.purpose}</p>
                <ul>
                  {page.actions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <aside className="panel data-panel">
          <h2>Data Contracts</h2>
          {entities.map((entity) => (
            <article key={entity.name}>
              <h3>{entity.name}</h3>
              <p>{entity.fields.length} fields, required: {entity.requiredFields.join(", ") || "none"}</p>
            </article>
          ))}

          <h2>Local Database</h2>
          <p className="db-status" data-status={status}>
            {status === "loading" ? "Loading local SQLite database…"
              : status === "ready" ? \`Persisted to localStorage. \${totalRecords} \${totalRecords === 1 ? "record" : "records"} on hand.\`
              : \`Database error: \${error ?? "unknown"}\`}
          </p>
          {status === "ready" ? (
            <button type="button" className="db-reset" onClick={reset}>
              Reset to seed data
            </button>
          ) : null}
        </aside>
      </section>

      <section className="panel workbench-panel" aria-label="Entity workbench">
        <h2>Workbench</h2>
        <p className="workbench-hint">
          Records persist to your browser via sql.js + localStorage. Refresh the page — your changes stay.
        </p>
        <div className="workbench-grid">
          {entities.map((entity) => (
            <EntityWorkbench
              key={entity.name}
              entity={entity}
              rows={data[entity.name] ?? []}
              onCreate={(row) => insert(entity.name, row)}
              onRemove={(id) => remove(entity.name, id)}
            />
          ))}
        </div>
      </section>

      <section className="panel api-panel">
        <h2>API Surface</h2>
        <div className="api-grid">
          {apiRoutes.map((route) => (
            <article key={\`\${route.method} \${route.path}\`}>
              <strong>{route.method}</strong>
              <code>{route.path}</code>
              <span>{route.authRequired ? route.requiredRole ?? "private" : "public"}</span>
            </article>
          ))}
        </div>
      </section>

      <footer>
        Route access policy: {routeAccess.decisions.join(" ")}
      </footer>
    </main>
  );
}`;
}

function renderGeneratedStylesCss(): string {
  // Legacy template CSS. Mirrors the design vocabulary the LLM-driven
  // generator is instructed to follow (slate neutrals, single indigo accent,
  // generous whitespace on a 8/16/24/40 rhythm, sticky header, max-width
  // container) so even when `PACKETAGENT_LEGACY_TEMPLATES=1` is on the
  // generated app reads as a polished product rather than a wireframe.
  return `:root {
  /* Palette - aligned with Tailwind slate + indigo so the legacy template
     looks the same family as the LLM-authored ones. */
  --color-bg: #f8fafc;             /* slate-50  */
  --color-surface: #ffffff;
  --color-surface-muted: #f1f5f9;  /* slate-100 */
  --color-border: #e2e8f0;         /* slate-200 */
  --color-border-strong: #cbd5e1;  /* slate-300 */
  --color-text: #0f172a;           /* slate-900 */
  --color-text-muted: #475569;     /* slate-600 */
  --color-text-faint: #64748b;     /* slate-500 */
  --color-accent: #4f46e5;         /* indigo-600 */
  --color-accent-hover: #4338ca;   /* indigo-700 */
  --color-accent-ring: rgba(99, 102, 241, 0.4);
  --color-success: #047857;        /* emerald-700 */
  --color-success-bg: #ecfdf5;     /* emerald-50  */
  --color-danger: #be123c;         /* rose-700 */
  --color-danger-bg: #fff1f2;      /* rose-50    */

  /* Spacing rhythm: 8 / 16 / 24 / 40 */
  --space-1: 8px;
  --space-2: 16px;
  --space-3: 24px;
  --space-4: 40px;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;

  --shadow-sm: 0 1px 2px 0 rgba(15, 23, 42, 0.04);
  --shadow-md: 0 1px 3px 0 rgba(15, 23, 42, 0.06), 0 1px 2px -1px rgba(15, 23, 42, 0.04);

  color: var(--color-text);
  background: var(--color-bg);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
}

* {
  box-sizing: border-box;
}

a {
  color: var(--color-accent);
  text-decoration: none;
  transition: color 120ms ease;
}

a:hover {
  color: var(--color-accent-hover);
}

button {
  font-family: inherit;
}

h1,
h2,
h3,
h4,
p,
ul,
ol,
dl {
  margin-top: 0;
}

h1 {
  color: var(--color-text);
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.2;
  margin-bottom: var(--space-1);
}

h2 {
  color: var(--color-text);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.005em;
  margin-bottom: var(--space-2);
}

h3 {
  color: var(--color-text);
  font-size: 15px;
  font-weight: 500;
  margin-bottom: var(--space-1);
}

p {
  color: var(--color-text-muted);
  margin-bottom: 0;
}

small,
code {
  color: var(--color-text-faint);
  font-size: 12px;
}

code {
  background: var(--color-surface-muted);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 1px 6px;
}

/* Sticky header replaces the page-flush hero. Title + summary land in the
   header, stats sit in the first content section so the page feels like a
   real product instead of a single hero slab. */
.app-shell {
  background: var(--color-bg);
  min-height: 100vh;
  padding-bottom: var(--space-4);
}

.hero {
  background: rgba(255, 255, 255, 0.85);
  -webkit-backdrop-filter: saturate(180%) blur(8px);
  backdrop-filter: saturate(180%) blur(8px);
  border-bottom: 1px solid var(--color-border);
  display: grid;
  gap: var(--space-3);
  grid-template-columns: minmax(0, 1fr) auto;
  margin-bottom: var(--space-4);
  padding: var(--space-3) var(--space-4);
  position: sticky;
  top: 0;
  z-index: 10;
}

.hero > div {
  max-width: 720px;
}

.hero p {
  font-size: 14px;
}

.eyebrow,
.access {
  color: var(--color-text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  margin: 0 0 6px;
  text-transform: uppercase;
}

.hero-stats {
  align-self: center;
  display: grid;
  gap: var(--space-1);
  grid-auto-flow: column;
  margin: 0;
}

.hero-stats div {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  min-width: 96px;
  padding: 10px 14px;
  text-align: left;
}

dt {
  color: var(--color-text-faint);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

dd {
  color: var(--color-text);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 4px 0 0;
}

/* Main content sits inside a max-width container, not flush to the edge. */
.layout-grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: 240px minmax(0, 1fr) 320px;
  margin: 0 auto;
  max-width: 1200px;
  padding: 0 var(--space-3);
}

.panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: var(--space-3);
}

.route-nav {
  align-content: start;
  display: grid;
  gap: 6px;
}

.route-nav a {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  transition: background 120ms ease, border-color 120ms ease;
}

.route-nav a:hover {
  background: var(--color-surface-muted);
  border-color: var(--color-border);
  color: var(--color-text);
}

.route-nav a small {
  color: var(--color-text-faint);
}

.cards,
.api-grid {
  display: grid;
  gap: var(--space-2);
}

.page-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.page-card:hover {
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-md);
}

.page-card ul {
  color: var(--color-text-muted);
  margin-bottom: 0;
  margin-top: 10px;
  padding-left: 18px;
}

.page-card li + li {
  margin-top: 4px;
}

.data-panel article {
  border-top: 1px solid var(--color-border);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
}

.data-panel article:first-of-type {
  border-top: 0;
  margin-top: 0;
  padding-top: 0;
}

.api-panel {
  margin: var(--space-3) auto 0;
  max-width: 1200px;
  width: calc(100% - 2 * var(--space-3));
}

.api-grid {
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}

.api-grid article {
  align-items: center;
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  display: grid;
  gap: 12px;
  grid-template-columns: 64px minmax(0, 1fr) auto;
  padding: 12px 14px;
}

.api-grid article strong {
  color: var(--color-accent);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.api-grid article span {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 500;
  padding: 2px 10px;
}

footer {
  color: var(--color-text-faint);
  margin: var(--space-3) auto 0;
  max-width: 1200px;
  padding: var(--space-2) var(--space-3) 0;
}

.workbench-panel {
  margin: var(--space-3) auto 0;
  max-width: 1200px;
  width: calc(100% - 2 * var(--space-3));
}

.workbench-hint {
  color: var(--color-text-muted);
  margin-bottom: var(--space-2);
}

.workbench-grid {
  display: grid;
  gap: var(--space-2);
}

.entity-workbench {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.entity-workbench header {
  align-items: baseline;
  display: flex;
  gap: var(--space-1);
  justify-content: space-between;
  margin-bottom: var(--space-2);
}

.entity-workbench header h3 {
  margin: 0;
  text-transform: capitalize;
}

.row-count {
  color: var(--color-text-faint);
  font-size: 12px;
}

.entity-form-grid {
  display: grid;
  gap: var(--space-2);
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.entity-form-grid label {
  display: grid;
  font-size: 12px;
  font-weight: 500;
  gap: 6px;
  color: var(--color-text-muted);
}

.entity-form-grid label.entity-form-wide {
  grid-column: 1 / -1;
}

.entity-form-grid input,
.entity-form-grid select,
.entity-form-grid textarea {
  background: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font: inherit;
  font-size: 14px;
  padding: 8px 12px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.entity-form-grid input:focus,
.entity-form-grid select:focus,
.entity-form-grid textarea:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-ring);
  outline: none;
}

.entity-form-grid textarea {
  min-height: 72px;
  resize: vertical;
}

.entity-form-actions {
  margin-top: var(--space-2);
}

.entity-form-actions button {
  background: var(--color-accent);
  border: 0;
  border-radius: var(--radius-sm);
  color: #ffffff;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  padding: 9px 16px;
  transition: background 120ms ease, box-shadow 120ms ease;
}

.entity-form-actions button:hover {
  background: var(--color-accent-hover);
}

.entity-form-actions button:focus-visible {
  box-shadow: 0 0 0 3px var(--color-accent-ring);
  outline: none;
}

.entity-form-error {
  background: var(--color-danger-bg);
  border: 1px solid #fecdd3;
  border-radius: var(--radius-sm);
  color: var(--color-danger);
  font-size: 13px;
  margin: var(--space-1) 0 0;
  padding: 8px 12px;
}

.entity-table-wrap {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-top: var(--space-2);
  max-height: 360px;
  overflow: auto;
}

.entity-table {
  border-collapse: collapse;
  font-size: 13px;
  width: 100%;
}

.entity-table th,
.entity-table td {
  border-bottom: 1px solid var(--color-border);
  padding: 10px 14px;
  text-align: left;
  vertical-align: top;
}

.entity-table tr:last-child td {
  border-bottom: 0;
}

.entity-table th {
  background: var(--color-surface-muted);
  color: var(--color-text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  position: sticky;
  text-transform: uppercase;
  top: 0;
}

/* Friendlier empty state: a centered hint inside the table area instead of
   a bare "No records yet." italic line. */
.entity-table-empty {
  color: var(--color-text-faint);
  font-style: normal;
  padding: var(--space-3);
  text-align: center;
}

.entity-table-empty::before {
  content: "";
  background: var(--color-surface-muted);
  border-radius: 999px;
  display: inline-block;
  height: 36px;
  margin-bottom: 8px;
  width: 36px;
}

.entity-row-remove {
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-danger);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  transition: background 120ms ease, border-color 120ms ease;
}

.entity-row-remove:hover {
  background: var(--color-danger-bg);
  border-color: #fda4af;
}

.db-status {
  background: var(--color-success-bg);
  border: 1px solid #a7f3d0;
  border-radius: var(--radius-sm);
  color: var(--color-success);
  font-size: 13px;
  margin-bottom: var(--space-2);
  padding: 8px 12px;
}

.db-status[data-status="loading"] {
  background: var(--color-surface-muted);
  border-color: var(--color-border);
  color: var(--color-text-muted);
}

.db-status[data-status="error"] {
  background: var(--color-danger-bg);
  border-color: #fecdd3;
  color: var(--color-danger);
}

.db-reset {
  background: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;
  transition: background 120ms ease, color 120ms ease;
}

.db-reset:hover {
  background: var(--color-surface-muted);
  color: var(--color-text);
}

@media (max-width: 1080px) {
  .layout-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .hero-stats {
    grid-auto-flow: row;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .hero {
    grid-template-columns: 1fr;
    padding: var(--space-2) var(--space-3);
  }

  .hero-stats {
    grid-template-columns: 1fr;
  }

  .layout-grid,
  .api-panel,
  .workbench-panel,
  footer {
    padding: 0 var(--space-2);
    width: calc(100% - 2 * var(--space-2));
  }
}`;
}

function renderGeneratedPageDataTs(
  pages: ReturnType<typeof buildGeneratedPageData>,
  routeSummary: {
    publicRoutes: string[];
    privateRoutes: string[];
    adminRoutes: string[];
    decisions: string[];
  },
): string {
  return `export type GeneratedPageAccess = "public" | "private" | "admin";

export type GeneratedPage = {
  route: string;
  name: string;
  access: GeneratedPageAccess;
  purpose: string;
  primaryEntity?: string;
  actions: string[];
  components: string[];
};

export const pages: GeneratedPage[] = ${JSON.stringify(pages, null, 2)};

export const routeAccess = ${JSON.stringify(routeSummary, null, 2)};`;
}

function renderGeneratedApiTs(
  apiRoutes: Array<{
    method: ApiRouteStub["method"];
    path: string;
    access: RouteAccess;
    authRequired: boolean;
    requiredRole?: "admin";
    purpose: string;
    requestBody?: string;
    responseShape: string;
  }>,
  dataContracts: {
    database: DataSchemaDraft["database"];
    entities: Array<{
      name: string;
      primaryKey: string;
      requiredFields: string[];
      editableFields: string[];
      fields: FieldSchemaDraft[];
      indexes: string[];
      relations: string[];
    }>;
    notes: string[];
  },
): string {
  return `import seedData from "../data/seed-data.json";

export type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type RouteAccess = "public" | "private" | "admin";

export type GeneratedApiRoute = {
  method: ApiMethod;
  path: string;
  access: RouteAccess;
  authRequired: boolean;
  requiredRole?: "admin";
  purpose: string;
  requestBody?: string;
  responseShape: string;
};

export const apiRoutes: GeneratedApiRoute[] = ${JSON.stringify(apiRoutes, null, 2)};

export const dataContracts = ${JSON.stringify(dataContracts, null, 2)};

type SeedData = Record<string, Array<Record<string, string | number | boolean | null>>>;
type ApiRequest = {
  method: ApiMethod;
  path: string;
  body?: Record<string, unknown>;
};

const records = seedData as SeedData;

export async function handleGeneratedApiRequest(request: ApiRequest) {
  const route = apiRoutes.find((candidate) => (
    candidate.method === request.method && routeMatches(candidate.path, request.path)
  ));

  if (!route) {
    return { status: 404, body: { error: "No generated API route matches this request." } };
  }

  const entityName = entityFromRoute(route.path);
  const entityRecords = entityName ? records[entityName] ?? [] : [];

  if (request.method === "GET") {
    return { status: 200, body: route.path.includes("/:id") ? entityRecords[0] ?? null : entityRecords };
  }

  const contract = dataContracts.entities.find((entity) => entity.name === entityName);
  const missingFields = contract
    ? contract.requiredFields.filter((field) => request.body?.[field] === undefined || request.body?.[field] === "")
    : [];

  if (missingFields.length > 0) {
    return { status: 400, body: { error: "Missing required fields.", missingFields } };
  }

  if (contract) {
    const enumErrors: Array<{ field: string; allowed: string[] }> = [];
    for (const field of contract.fields) {
      if (field.type !== "enum" || !field.enumValues || field.enumValues.length === 0) continue;
      const provided = request.body?.[field.name];
      if (provided === undefined || provided === null || provided === "") continue;
      if (!field.enumValues.includes(String(provided))) {
        enumErrors.push({ field: field.name, allowed: field.enumValues });
      }
    }
    if (enumErrors.length > 0) {
      return { status: 400, body: { error: "Invalid enum values.", enumErrors } };
    }
  }

  return {
    status: request.method === "POST" ? 201 : 200,
    body: {
      ok: true,
      route: route.path,
      entity: entityName,
      received: request.body ?? {},
    },
  };
}

function routeMatches(routePattern: string, requestPath: string) {
  const expression = new RegExp(\`^\${routePattern.replace(/:[^/]+/g, "[^/]+")}$\`);
  return expression.test(requestPath);
}

function entityFromRoute(path: string) {
  const segment = path.split("/").filter(Boolean).at(-1) === ":id"
    ? path.split("/").filter(Boolean).at(-2)
    : path.split("/").filter(Boolean).at(-1);
  if (!segment || segment === "session" || segment === "setup" || segment === "actions") return undefined;
  const normalized = segment.replace(/-/g, "").replace(/s$/, "");
  return dataContracts.entities.find((entity) => entity.name.toLowerCase() === normalized.toLowerCase())?.name;
}`;
}

function renderGeneratedReadme(
  draft: AppDraft,
  pages: ReturnType<typeof buildGeneratedPageData>,
  apiRoutes: Array<{ method: ApiRouteStub["method"]; path: string; access: RouteAccess; responseShape: string }>,
): string {
  const pageLines = pages.map((pageDraft) => `- ${pageDraft.name} (${pageDraft.route}) - ${pageDraft.access}: ${pageDraft.purpose}`);
  const apiLines = apiRoutes.map((route) => `- ${route.method} ${route.path} - ${route.access}, returns ${route.responseShape}`);
  const dataLines = draft.dataSchema.entities.map((entityDraft) => `- ${entityDraft.name}: ${entityDraft.fields.map((fieldDraft) => fieldDraft.name).join(", ")}`);

  return `# ${draft.appName}

${draft.summary}

## Run

\`\`\`bash
npm install
npm run dev
\`\`\`

## Pages

${pageLines.join("\n")}

## API

${apiLines.join("\n")}

## Data

${dataLines.join("\n")}

Seed records live in \`src/data/seed-data.json\` and are loaded by the UI and API handler.

## Acceptance Checks

${draft.acceptanceChecks.map((check) => `- ${generatedArtifactCopy(check)}`).join("\n")}`;
}
