// Derives an `AppDraft`-shaped view from a generated file tree.
//
// This is a **derived view**, not a source of truth. The file tree authored
// by the LLM (Track B) is canonical; the Files tab, Smoke tab, and publish
// flow all want an `AppDraft` so they keep working. This module bridges the
// two without changing the downstream contract.
//
// Quality matters less here than "downstream consumers don't crash". The
// heuristics below are deliberately forgiving — when something isn't present
// in the tree, we fall back to a sensible empty default rather than throw.

import type {
  ApiRouteStub,
  AppDraft,
  AppDraftTemplateId,
  AuthDraft,
  ComponentDraft,
  CrudFlowDraft,
  DataSchemaDraft,
  EntitySchemaDraft,
  FieldSchemaDraft,
  PageDraft,
  Phase71IntegrationMetadata,
  SeedRecord,
} from "../app-builder-service.js";
import type { GeneratedFile } from "./llm-author.js";

const DEFAULT_TEMPLATE_ID: AppDraftTemplateId = "internal_dashboard";

export function deriveDraftFromFiles(
  files: GeneratedFile[],
  userGoal: string,
  summary: string,
): AppDraft {
  const safe = Array.isArray(files) ? files : [];
  const byPath = indexByPath(safe);

  const appName = deriveAppName(byPath, userGoal);
  const pageMap = derivePageMap(safe);
  const apiRouteStubs = deriveApiRouteStubs(safe);
  const dataSchema = deriveDataSchema(safe);
  const components = deriveComponents(safe);
  const seedData = deriveSeedData(safe);
  const crudFlows = deriveCrudFlows(dataSchema);
  const auth = deriveAuth(pageMap);
  const integrationMetadata = emptyIntegrationMetadata();
  const safeSummary = (summary ?? "").trim() || `${appName} draft for: ${userGoal}`;

  return {
    prompt: userGoal,
    templateId: DEFAULT_TEMPLATE_ID,
    appName,
    summary: safeSummary,
    integrationMetadata,
    pageMap,
    components,
    apiRouteStubs,
    dataSchema,
    seedData,
    crudFlows,
    auth,
    acceptanceChecks: [
      "The generated app boots without runtime errors.",
      "Every page declared in the file tree is reachable from the entrypoint.",
    ],
  };
}

// --- helpers --------------------------------------------------------------

function indexByPath(files: GeneratedFile[]): Map<string, GeneratedFile> {
  const map = new Map<string, GeneratedFile>();
  for (const file of files) {
    if (!file || typeof file.path !== "string") continue;
    map.set(normalizePath(file.path), file);
  }
  return map;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function deriveAppName(byPath: Map<string, GeneratedFile>, userGoal: string): string {
  const pkg = byPath.get("package.json");
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg.content) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
        return prettifyAppName(parsed.name);
      }
    } catch {
      // fall through
    }
  }

  // Try the App component function/default-export name.
  const appFile = byPath.get("src/App.tsx") ?? byPath.get("src/App.jsx");
  if (appFile) {
    const fromComponent = extractAppComponentName(appFile.content);
    if (fromComponent) return prettifyAppName(fromComponent);
  }

  // Last-ditch fallback: derive from the user's goal so the UI still has a
  // name to render.
  const fallback = (userGoal ?? "").trim().split(/\s+/).slice(0, 3).join(" ");
  return fallback ? prettifyAppName(fallback) : "Generated App";
}

function extractAppComponentName(source: string): string | null {
  const fnMatch = source.match(/(?:export\s+default\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (fnMatch && fnMatch[1] && fnMatch[1] !== "App") return fnMatch[1];
  if (fnMatch && fnMatch[1] === "App") return "App";
  const exportMatch = source.match(/export\s+default\s+([A-Za-z_$][\w$]*)/);
  if (exportMatch) return exportMatch[1];
  return null;
}

function prettifyAppName(raw: string): string {
  const cleaned = raw
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  if (cleaned.length === 0) return "Generated App";
  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function derivePageMap(files: GeneratedFile[]): PageDraft[] {
  const pages: PageDraft[] = [];
  const pageFiles = files.filter((f) => isUnderDir(f.path, "src/pages"));

  if (pageFiles.length > 0) {
    for (const file of pageFiles) {
      const route = routeForPageFile(file.path);
      const name = nameForPageFile(file.path);
      pages.push({
        path: route,
        name,
        access: "private",
        purpose: `Page derived from ${normalizePath(file.path)}.`,
        actions: [],
      });
    }
  }

  // Always make sure there's at least one page so the Files / Smoke tabs
  // have something to render.
  const hasRoot = pages.some((p) => p.path === "/");
  if (!hasRoot) {
    const hasAppFile = files.some((f) => {
      const norm = normalizePath(f.path);
      return norm === "src/App.tsx" || norm === "src/App.jsx";
    });
    if (hasAppFile || pages.length === 0) {
      pages.unshift({
        path: "/",
        name: "Home",
        access: "private",
        purpose: hasAppFile ? "Root page rendered by src/App." : "Default landing page.",
        actions: [],
      });
    }
  }

  return pages;
}

function isUnderDir(filePath: string, dir: string): boolean {
  const norm = normalizePath(filePath);
  return norm === dir || norm.startsWith(`${dir}/`);
}

function routeForPageFile(filePath: string): string {
  const norm = normalizePath(filePath);
  const rel = norm.replace(/^src\/pages\/?/, "");
  // Strip extension.
  const noExt = rel.replace(/\.(tsx?|jsx?)$/i, "");
  if (noExt === "" || noExt.toLowerCase() === "index") return "/";
  // Next-style brackets → route params; Index files become parent route.
  const segments = noExt
    .split("/")
    .map((segment) => {
      if (segment.toLowerCase() === "index") return "";
      return segment.replace(/^\[\.\.\.(.+)\]$/, ":$1*").replace(/^\[(.+)\]$/, ":$1");
    })
    .filter((segment) => segment.length > 0);
  return "/" + segments.join("/");
}

function nameForPageFile(filePath: string): string {
  const norm = normalizePath(filePath);
  const base = norm.replace(/^src\/pages\/?/, "").replace(/\.(tsx?|jsx?)$/i, "");
  const last = base.split("/").pop() ?? "";
  if (!last || last.toLowerCase() === "index") return "Home";
  return prettifyAppName(last);
}

function deriveApiRouteStubs(files: GeneratedFile[]): ApiRouteStub[] {
  return files
    .filter((f) => isUnderDir(f.path, "src/api"))
    .map((file) => {
      const norm = normalizePath(file.path);
      const rel = norm.replace(/^src\/api\/?/, "").replace(/\.(tsx?|jsx?)$/i, "");
      const path = rel ? `/api/${rel}` : "/api";
      const method = inferApiMethod(file.content);
      return {
        method,
        path,
        access: "private",
        purpose: `API route derived from ${norm}.`,
        responseShape: "unknown",
      } satisfies ApiRouteStub;
    });
}

function inferApiMethod(source: string): ApiRouteStub["method"] {
  const text = (source ?? "").toString();
  if (/\bPOST\b/.test(text)) return "POST";
  if (/\bPATCH\b/.test(text)) return "PATCH";
  if (/\bDELETE\b/.test(text)) return "DELETE";
  return "GET";
}

function deriveDataSchema(files: GeneratedFile[]): DataSchemaDraft {
  const schemaFiles = files.filter(
    (f) => isUnderDir(f.path, "src/data") || isUnderDir(f.path, "src/schema"),
  );
  const entities: EntitySchemaDraft[] = schemaFiles
    .map((file) => deriveEntityFromFile(file))
    .filter((entity): entity is EntitySchemaDraft => entity !== null);

  return {
    database: "postgres",
    entities,
    notes: entities.length === 0 ? ["No data schema present in the generated file tree."] : [],
  };
}

function deriveEntityFromFile(file: GeneratedFile): EntitySchemaDraft | null {
  const norm = normalizePath(file.path);
  const base = norm.replace(/^src\/(data|schema)\/?/, "").replace(/\.(tsx?|jsx?|json)$/i, "");
  const name = base.split("/").pop() ?? "";
  if (!name) return null;
  const fields: FieldSchemaDraft[] = [{ name: "id", type: "uuid", required: true }];
  return {
    name,
    primaryKey: "id",
    fields,
    indexes: [],
    relations: [],
  };
}

function deriveComponents(files: GeneratedFile[]): ComponentDraft[] {
  return files
    .filter((f) => isUnderDir(f.path, "src/components"))
    .map((file) => {
      const norm = normalizePath(file.path);
      const base = norm.replace(/^src\/components\/?/, "").replace(/\.(tsx?|jsx?)$/i, "");
      const name =
        (base.split("/").pop() ?? "Component").replace(/[^A-Za-z0-9_]/g, "") || "Component";
      return {
        name,
        type: "list" as const,
        usedOn: [],
        responsibilities: [`Component derived from ${norm}.`],
      };
    });
}

function deriveSeedData(_files: GeneratedFile[]): Record<string, SeedRecord[]> {
  // Seed data is not represented in the file-tree contract today; downstream
  // consumers tolerate an empty record, so that is the safest default.
  return {};
}

function deriveCrudFlows(schema: DataSchemaDraft): CrudFlowDraft[] {
  return schema.entities.map((entity) => ({
    entity: entity.name,
    create: [],
    read: [],
    update: [],
    delete: [],
  }));
}

function deriveAuth(pages: PageDraft[]): AuthDraft {
  const publicRoutes = pages.filter((p) => p.access === "public").map((p) => p.path);
  const privateRoutes = pages.filter((p) => p.access !== "public").map((p) => p.path);
  return {
    defaultPolicy: "authenticated-by-default",
    publicRoutes,
    privateRoutes,
    roleRoutes: [],
    decisions: [
      "Auth bucketing was derived from the file tree; all non-public pages are treated as private.",
    ],
  };
}

function emptyIntegrationMetadata(): Phase71IntegrationMetadata {
  return { requested: [], setupGuidance: [] };
}
