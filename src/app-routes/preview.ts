import { type Context, type Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireAuthenticatedContextAsync } from "../packetagent-services.js";
import { loadStoreAsync } from "../packetagent-store.js";
import { resolveGeneratedAppPreviewFile } from "../generated-app-process.js";
import {
  buildGeneratedAppRuntimeModel,
  summarizeGeneratedAppSourceFiles,
} from "../generated-app-runtime.js";
import { getDefaultGeneratedAppRuntimeProcessPool } from "../generated-app-runtime/server.js";
import { errorResponse, httpRouteError, requireWorkspacePermission } from "./shared.js";
import {
  checkpointForPublish,
  findGeneratedAppRecord,
  generatedAppRuntimeArtifact,
  type AppBuilderDraftContract,
  type GeneratedAppRecordWithRuntime,
} from "./builder-core.js";

async function previewGeneratedApp(c: Context) {
  try {
    const appIdParam = c.req.param("appId") ?? "";
    const tokenQuery = c.req.query("token");
    let workspaceId: string;
    let record: GeneratedAppRecordWithRuntime;

    // Token-based auth path (read-only). Lets phones / other devices on the
    // LAN load the preview without a workspace session cookie.
    if (tokenQuery) {
      const verification = await verifyPreviewToken(tokenQuery, appIdParam);
      if (!verification.ok) {
        c.status(401);
        return c.json({ error: "preview link expired or invalid" });
      }
      record = verification.record;
      workspaceId = record.workspaceId;
    } else {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "viewWorkspace");
      const found = await findGeneratedAppRecord(context, appIdParam, c.req.query("checkpointId"));
      if (!found) throw httpRouteError(404, "generated app not found");
      record = found;
      workspaceId = context.workspace.id;
    }

    const checkpoint = checkpointForPublish(record, c.req.query("checkpointId"));
    if (!checkpoint) throw httpRouteError(404, "checkpoint not found");
    const artifact = generatedAppRuntimeArtifact(record, checkpoint);
    const requestedPath = c.req.param("*") || generatedAppPreviewPathFromRequest(c, appIdParam);
    const resolved = resolveGeneratedAppPreviewFile({
      appId: record.id,
      workspaceId,
      checkpointId: checkpoint.id,
      artifact,
      requestedPath,
    });
    c.header("Cache-Control", "no-store");
    c.header("X-PacketAgent-Generated-App-Id", record.id);
    c.header("X-PacketAgent-Generated-App-Slug", record.slug);
    c.header("X-PacketAgent-Generated-App-Checkpoint", checkpoint.id);
    c.header("X-PacketAgent-Generated-App-Runtime", resolved.readiness.mode);
    c.header("X-PacketAgent-Generated-App-Live", String(resolved.readiness.live));

    if (wantsGeneratedAppPreviewReadiness(c)) {
      return c.json({
        app: {
          id: record.id,
          slug: record.slug,
          name: record.name,
        },
        checkpoint: {
          id: checkpoint.id,
          appId: checkpoint.appId,
          createdAt: checkpoint.createdAt,
        },
        preview: {
          path: resolved.path,
          runtime: resolved.readiness,
        },
        artifact: {
          entrypoint: artifact.entrypoint,
          renderedAt: artifact.renderedAt,
          files: summarizeGeneratedAppSourceFiles(artifact.files),
        },
      });
    }

    if (!("file" in resolved) && requestedPath && !requestedPath.includes(".")) {
      const fallback = resolveGeneratedAppPreviewFile({
        appId: record.id,
        workspaceId,
        checkpointId: checkpoint.id,
        artifact,
      });
      if ("file" in fallback) {
        c.header("X-PacketAgent-Generated-App-Fallback", "entrypoint");
        const { content: fbContent, contentType: fbType } = await transformPreviewFile(
          fallback.file.path,
          fallback.file.content,
          fallback.file.contentType,
        );
        c.header("Content-Type", fbType);
        return c.body(fbContent);
      }
    }

    if (!("file" in resolved)) throw httpRouteError(404, "preview file not found");
    const { content: outContent, contentType: outType } = await transformPreviewFile(
      resolved.file.path,
      resolved.file.content,
      resolved.file.contentType,
    );
    c.header("Content-Type", outType);
    return c.body(outContent);
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function handleGeneratedAppRuntimeApi(c: Context) {
  try {
    const appIdParam = c.req.param("appId") ?? "";
    const tokenQuery = c.req.query("token");
    let record: GeneratedAppRecordWithRuntime;
    let workspaceId: string;

    if (tokenQuery) {
      const verification = await verifyPreviewToken(tokenQuery, appIdParam);
      if (!verification.ok) {
        c.status(401);
        return c.json({ error: "preview link expired or invalid" });
      }
      if (!isGeneratedAppReadOnlyMethod(c.req.method)) {
        c.status(403);
        return c.json({ error: "preview links can only read generated app runtime data" });
      }
      record = verification.record;
      workspaceId = record.workspaceId;
    } else {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "viewWorkspace");
      const found = await findGeneratedAppRecord(context, appIdParam, c.req.query("checkpointId"));
      if (!found) throw httpRouteError(404, "generated app not found");
      record = found;
      workspaceId = context.workspace.id;
    }

    const checkpoint = checkpointForPublish(record, c.req.query("checkpointId"));
    if (!checkpoint) throw httpRouteError(404, "checkpoint not found");
    const model = buildGeneratedAppRuntimeModel(
      checkpoint.draft as unknown as AppBuilderDraftContract,
    );
    const result = await getDefaultGeneratedAppRuntimeProcessPool().request({
      appId: record.id,
      workspaceId,
      model,
      runtimeRoot: process.env.PACKETAGENT_GENERATED_APP_RUNTIME_DIR,
      method: c.req.method,
      path: generatedAppRuntimeApiPathFromRequest(c, appIdParam) || model.primaryEntity,
      body: await readGeneratedAppRuntimeBody(c),
    });
    c.status(result.status as ContentfulStatusCode);
    c.header("Cache-Control", "no-store");
    c.header("X-PacketAgent-Generated-App-Id", record.id);
    c.header("X-PacketAgent-Generated-App-Checkpoint", checkpoint.id);
    c.header("X-PacketAgent-Generated-App-Runtime", "server-sqlite-process");
    if (result.process.pid)
      c.header("X-PacketAgent-Generated-App-Runtime-Pid", String(result.process.pid));
    return c.json(result.body);
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function generatedAppRuntimeWorkspaceHealth(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    c.header("Cache-Control", "private, no-store");
    return c.json({
      scope: { workspaceId: context.workspace.id },
      health: getDefaultGeneratedAppRuntimeProcessPool().health({
        workspaceId: context.workspace.id,
      }),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function generatedAppRuntimeAppHealth(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const record = await findGeneratedAppRecord(context, c.req.param("appId"));
    if (!record) throw httpRouteError(404, "generated app not found");
    c.header("Cache-Control", "private, no-store");
    return c.json({
      scope: { workspaceId: context.workspace.id, appId: record.id },
      health: getDefaultGeneratedAppRuntimeProcessPool().health({
        workspaceId: context.workspace.id,
        appId: record.id,
      }),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

function wantsGeneratedAppPreviewReadiness(c: Context) {
  const format = (c.req.query("format") ?? c.req.query("readiness") ?? "").toLowerCase();
  if (format === "json" || format === "1" || format === "true") return true;
  const accept = c.req.header("accept") ?? "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

// --- Signed preview tokens ------------------------------------------------
// Stateless HMAC-SHA256 tokens that grant read-only access to a single
// generated app's preview route. Token format:
//   tk_<appId>_<expiryUnixSec>_<base64urlHmac>
// HMAC covers `${appId}.${expiryUnixSec}` so a token for one app can't be
// reused for another and tampering with the expiry invalidates it. Tokens
// are NOT stored — verification is purely cryptographic + time check.
const PREVIEW_TOKEN_PREFIX = "tk_";
const PREVIEW_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour
const PREVIEW_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const PREVIEW_TOKEN_DEV_FALLBACK_SECRET =
  "packetagent-preview-token-dev-fallback-DO-NOT-USE-IN-PROD";
let previewTokenFallbackWarned = false;

function previewTokenSecret(): string {
  const fromPreview = (process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET ?? "").trim();
  if (fromPreview) return fromPreview;
  const fromMaster = (process.env.PACKETAGENT_MASTER_KEY ?? "").trim();
  if (fromMaster) return fromMaster;
  // In production we MUST NOT sign/verify with a constant baked-in secret —
  // anyone reading the source could forge preview tokens. Refuse outright so the
  // operator is forced to configure a real secret.
  if (process.env.NODE_ENV === "production") {
    throw httpRouteError(
      500,
      "preview tokens are unavailable: set PACKETAGENT_PREVIEW_TOKEN_SECRET or PACKETAGENT_MASTER_KEY",
    );
  }
  if (!previewTokenFallbackWarned) {
    previewTokenFallbackWarned = true;
    console.warn(
      "[preview-token] No PACKETAGENT_PREVIEW_TOKEN_SECRET or PACKETAGENT_MASTER_KEY set — falling back to an in-process dev secret. Do NOT run this in production without configuring one of those env vars.",
    );
  }
  return PREVIEW_TOKEN_DEV_FALLBACK_SECRET;
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function previewTokenHmac(appId: string, expirySec: number): string {
  return base64UrlEncode(
    createHmac("sha256", previewTokenSecret()).update(`${appId}.${expirySec}`).digest(),
  );
}

function buildPreviewToken(appId: string, expirySec: number): string {
  // Use "." as the separator: it's NOT in the base64url alphabet
  // (which is A-Za-z0-9_-), so the HMAC chunk can never collide with it.
  // Generated app ids look like `gapp_<hex>` and never contain dots either.
  return `${PREVIEW_TOKEN_PREFIX}${appId}.${expirySec}.${previewTokenHmac(appId, expirySec)}`;
}

function parsePreviewToken(
  token: string,
): { appId: string; expirySec: number; hmac: string } | null {
  if (!token.startsWith(PREVIEW_TOKEN_PREFIX)) return null;
  const remainder = token.slice(PREVIEW_TOKEN_PREFIX.length);
  const parts = remainder.split(".");
  if (parts.length !== 3) return null;
  const [appId, expiryRaw, hmac] = parts;
  const expirySec = Number.parseInt(expiryRaw, 10);
  if (!Number.isFinite(expirySec) || expirySec <= 0) return null;
  if (!appId || !hmac) return null;
  return { appId, expirySec, hmac };
}

async function verifyPreviewToken(
  rawToken: string,
  routeAppId: string,
): Promise<{ ok: true; record: GeneratedAppRecordWithRuntime } | { ok: false }> {
  const parsed = parsePreviewToken(rawToken);
  if (!parsed) return { ok: false };
  if (parsed.appId !== routeAppId) return { ok: false };
  if (parsed.expirySec * 1000 < Date.now()) return { ok: false };
  let expected: string;
  try {
    expected = previewTokenHmac(parsed.appId, parsed.expirySec);
  } catch {
    // No real secret configured in production: refuse to verify (rather than
    // accept tokens forged against the baked-in dev fallback).
    return { ok: false };
  }
  const provided = parsed.hmac;
  if (expected.length !== provided.length) return { ok: false };
  let equal = false;
  try {
    equal = timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return { ok: false };
  }
  if (!equal) return { ok: false };
  const data = await loadStoreAsync();
  const record = ((data.generatedApps ?? []) as GeneratedAppRecordWithRuntime[]).find(
    (entry) => entry.id === parsed.appId,
  );
  if (!record) return { ok: false };
  return { ok: true, record };
}

async function createGeneratedAppPreviewToken(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const appIdParam = c.req.param("appId") ?? "";
    const record = await findGeneratedAppRecord(context, appIdParam);
    if (!record) throw httpRouteError(404, "generated app not found");

    const ttlRaw = Number.parseInt(c.req.query("ttl") ?? "", 10);
    const ttlSeconds =
      Number.isFinite(ttlRaw) && ttlRaw > 0
        ? Math.min(ttlRaw, PREVIEW_TOKEN_MAX_TTL_SECONDS)
        : PREVIEW_TOKEN_DEFAULT_TTL_SECONDS;
    const expirySec = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = buildPreviewToken(record.id, expirySec);
    const previewUrl = `/api/app/generated-apps/${encodeURIComponent(record.id)}/preview/?token=${encodeURIComponent(token)}`;

    return c.json({
      token,
      expiresAt: new Date(expirySec * 1000).toISOString(),
      previewUrl,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

// Import map injected into generated-app HTML so the browser can resolve
// the bare `react`, `react-dom`, and `react/jsx-runtime` specifiers that
// esbuild's automatic JSX runtime emits. Without this, the iframe throws
// "Failed to resolve module specifier 'react/jsx-runtime'" and the preview
// renders as broken/unstyled. A future Phase 3 will replace this with a
// proper Vite build cached per checkpoint that ships its own bundle.
const PREVIEW_IMPORT_MAP = `<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@19.0.0",
    "react/": "https://esm.sh/react@19.0.0/",
    "react-dom": "https://esm.sh/react-dom@19.0.0",
    "react-dom/": "https://esm.sh/react-dom@19.0.0/",
    "react/jsx-runtime": "https://esm.sh/react@19.0.0/jsx-runtime"
  }
}
</script>`;

// Transform .tsx/.ts files to executable JS at preview-serve time. The generated
// app's index.html loads /src/main.tsx as a module script; browsers reject the
// raw TS source (text/typescript MIME) so we transpile via esbuild on each request.
// HTML files get an importmap injected so the transformed JS can resolve bare
// react/react-dom imports against an ESM CDN.
async function transformPreviewFile(
  path: string,
  content: string,
  contentType: string,
): Promise<{ content: string; contentType: string }> {
  if (/\.html?$/.test(path)) {
    // Inject the importmap right after the opening <head> tag so it resolves
    // before any module script loads. If there is no <head>, prepend before <html>.
    let injected = content;
    if (/<head\b[^>]*>/i.test(injected)) {
      injected = injected.replace(/<head\b[^>]*>/i, (m) => `${m}\n${PREVIEW_IMPORT_MAP}`);
    } else if (/<html\b[^>]*>/i.test(injected)) {
      injected = injected.replace(
        /<html\b[^>]*>/i,
        (m) => `${m}\n<head>${PREVIEW_IMPORT_MAP}</head>`,
      );
    } else {
      injected = `${PREVIEW_IMPORT_MAP}\n${injected}`;
    }
    return { content: injected, contentType };
  }
  const isTs = /\.tsx?$/.test(path);
  if (!isTs) return { content, contentType };
  try {
    const { transform } = await import("esbuild");
    const result = await transform(content, {
      loader: path.endsWith(".tsx") ? "tsx" : "ts",
      jsx: "automatic",
      jsxImportSource: "react",
      target: "es2022",
      format: "esm",
      sourcefile: path,
    });
    return { content: result.code, contentType: "application/javascript; charset=utf-8" };
  } catch (error) {
    console.warn(`[preview-transform] failed for ${path}: ${(error as Error).message}`);
    return { content, contentType };
  }
}

function generatedAppPreviewPathFromRequest(c: Context, appId: string): string {
  const path = new URL(c.req.url).pathname.replace(/\\/g, "/");
  const markers = [
    `/api/app/generated-apps/${encodeURIComponent(appId)}/preview/`,
    `/app/generated-apps/${encodeURIComponent(appId)}/preview/`,
    `/api/app/generated-apps/${appId}/preview/`,
    `/app/generated-apps/${appId}/preview/`,
  ];
  const marker = markers.find((candidate) => path.includes(candidate));
  if (!marker) return "";
  return decodeURIComponent(path.slice(path.indexOf(marker) + marker.length));
}

function generatedAppRuntimeApiPathFromRequest(c: Context, appId: string): string {
  const wildcard = c.req.param("*");
  if (wildcard) return wildcard.replace(/^\/+/, "");
  const path = new URL(c.req.url).pathname.replace(/\\/g, "/");
  const markers = [
    `/api/app/generated-apps/${encodeURIComponent(appId)}/api/`,
    `/app/generated-apps/${encodeURIComponent(appId)}/api/`,
    `/api/app/generated-apps/${appId}/api/`,
    `/app/generated-apps/${appId}/api/`,
    `/api/app/generated-apps/${encodeURIComponent(appId)}/api`,
    `/app/generated-apps/${encodeURIComponent(appId)}/api`,
    `/api/app/generated-apps/${appId}/api`,
    `/app/generated-apps/${appId}/api`,
  ];
  const marker = markers.find((candidate) => path.includes(candidate));
  if (!marker) return "";
  return decodeURIComponent(path.slice(path.indexOf(marker) + marker.length)).replace(/^\/+/, "");
}

async function readGeneratedAppRuntimeBody(
  c: Context,
): Promise<Record<string, unknown> | undefined> {
  if (isGeneratedAppReadOnlyMethod(c.req.method)) return undefined;
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return undefined;
  const parsed = (await c.req.json().catch(() => undefined)) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function isGeneratedAppReadOnlyMethod(method: string): boolean {
  return method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
}

export function registerPreviewRoutes(app: Hono): void {
  app.get("/app/generated-app-runtime/health", async (c) => generatedAppRuntimeWorkspaceHealth(c));
  app.get("/app/generated-apps/:appId/runtime/health", async (c) =>
    generatedAppRuntimeAppHealth(c),
  );
  app.get("/app/generated-apps/:appId/preview", async (c) => previewGeneratedApp(c));
  app.get("/app/generated-apps/:appId/preview/*", async (c) => previewGeneratedApp(c));
  app.post("/app/generated-apps/:appId/preview-token", async (c) =>
    createGeneratedAppPreviewToken(c),
  );
  app.get("/app/generated-apps/:appId/api", async (c) => handleGeneratedAppRuntimeApi(c));
  app.get("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
  app.post("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
  app.put("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
  app.patch("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
  app.delete("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
}
