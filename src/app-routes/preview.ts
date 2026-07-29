import { type Context, type Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomBytes } from "node:crypto";
import {
  mintGeneratedPreviewCapability,
  normalizeHttpOrigin,
  verifyGeneratedPreviewCapability,
  type GeneratedPreviewCapabilityClaims,
  type GeneratedPreviewCapabilityScope,
} from "../app-preview-capability.js";
import {
  generatedPreviewBootstrapUrl,
  generatedPreviewCookieName,
  generatedPreviewCookiePath,
  isPacketAgentPreviewOriginRequest,
  requestOrigin,
  resolvePacketAgentAppOrigin,
  resolvePacketAgentPreviewOrigin,
} from "../app-preview-isolation.js";
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
    requirePreviewOrigin(c);
    if (c.req.query("token")) {
      throw httpRouteError(
        400,
        "preview capabilities must be delivered in the URL fragment, not the query string",
      );
    }
    const requestedPath = c.req.param("*") || generatedAppPreviewPathFromRequest(c, appIdParam);
    const authorization = await authorizeGeneratedPreviewRequest(c, appIdParam);
    if (!authorization.ok) {
      if (!requestedPath || requestedPath === "index.html") {
        return generatedPreviewBootstrap(c, appIdParam);
      }
      throw httpRouteError(401, "preview session expired or invalid");
    }
    const { claims, record, checkpoint } = authorization;
    const workspaceId = claims.workspaceId;
    const artifact = generatedAppRuntimeArtifact(record, checkpoint);
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
    const nonce = previewResponseNonce();
    applyGeneratedPreviewDocumentHeaders(c, claims, nonce);

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
          nonce,
          claims,
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
      nonce,
      claims,
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
    requirePreviewOrigin(c);
    const authorization = await authorizeGeneratedPreviewRequest(c, appIdParam);
    if (!authorization.ok) throw httpRouteError(401, "preview session expired or invalid");
    if (authorization.claims.scope === "read" && !isGeneratedAppReadOnlyMethod(c.req.method)) {
      throw httpRouteError(403, "shared preview sessions can only read runtime data");
    }
    const { claims, record, checkpoint } = authorization;
    const workspaceId = claims.workspaceId;
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
    applyGeneratedPreviewApiHeaders(c);
    if (result.process.pid)
      c.header("X-PacketAgent-Generated-App-Runtime-Pid", String(result.process.pid));
    return c.json(result.body);
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function generatedAppRuntimeWorkspaceHealth(c: Context) {
  try {
    requirePrimaryOrigin(c);
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
    requirePrimaryOrigin(c);
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

async function createGeneratedAppPreviewToken(c: Context) {
  try {
    requirePrimaryOrigin(c);
    const context = await requireAuthenticatedContextAsync(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      checkpointId?: string;
      scope?: GeneratedPreviewCapabilityScope;
      ttlSeconds?: number;
    };
    const scope: GeneratedPreviewCapabilityScope = body.scope === "interact" ? "interact" : "read";
    await requireWorkspacePermission(
      context,
      scope === "interact" ? "manageWorkspace" : "viewWorkspace",
    );
    const appIdParam = c.req.param("appId") ?? "";
    const record = await findGeneratedAppRecord(context, appIdParam, body.checkpointId);
    if (!record) throw httpRouteError(404, "generated app not found");
    const checkpoint = checkpointForPublish(record, body.checkpointId);
    if (!checkpoint) throw httpRouteError(404, "checkpoint not found");

    const ttlRaw = Number.parseInt(c.req.query("ttl") ?? "", 10);
    const ttlSeconds =
      typeof body.ttlSeconds === "number" && Number.isFinite(body.ttlSeconds)
        ? Math.floor(body.ttlSeconds)
        : Number.isFinite(ttlRaw)
          ? ttlRaw
          : undefined;
    const parentOrigin = scope === "interact" ? interactivePreviewParentOrigin(c) : undefined;
    const { token, claims } = mintGeneratedPreviewCapability({
      appId: record.id,
      workspaceId: record.workspaceId,
      checkpointId: checkpoint.id,
      scope,
      parentOrigin,
      ttlSeconds,
    });
    const previewUrl = generatedPreviewBootstrapUrl(
      resolvePacketAgentPreviewOrigin(),
      record.id,
      token,
    );

    c.header("Cache-Control", "private, no-store");
    return c.json({
      token,
      scope: claims.scope,
      checkpointId: claims.checkpointId,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      previewUrl,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function createGeneratedAppPreviewSession(c: Context) {
  try {
    requirePreviewOrigin(c);
    requireSamePreviewOriginBootstrap(c);
    const appId = c.req.param("appId") ?? "";
    const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      throw httpRouteError(415, "preview session requests require application/json");
    }
    const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== "string" || body.token.length > 4096) {
      throw httpRouteError(400, "preview capability is required");
    }
    const authorization = await authorizeGeneratedPreviewToken(body.token, appId);
    if (!authorization.ok) throw httpRouteError(401, "preview link expired or invalid");
    const maxAge = Math.max(1, authorization.claims.exp - Math.floor(Date.now() / 1000));
    setCookie(c, generatedPreviewCookieName(appId), body.token, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      partitioned: true,
      path: generatedPreviewCookiePath(appId),
      maxAge,
    });
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.json({
      ok: true,
      redirectPath: `${generatedPreviewCookiePath(appId)}preview/`,
      scope: authorization.claims.scope,
      expiresAt: new Date(authorization.claims.exp * 1000).toISOString(),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

type AuthorizedGeneratedPreview = {
  ok: true;
  claims: GeneratedPreviewCapabilityClaims;
  record: GeneratedAppRecordWithRuntime;
  checkpoint: NonNullable<ReturnType<typeof checkpointForPublish>>;
};

async function authorizeGeneratedPreviewRequest(
  c: Context,
  appId: string,
): Promise<AuthorizedGeneratedPreview | { ok: false }> {
  const token = getCookie(c, generatedPreviewCookieName(appId));
  return token ? authorizeGeneratedPreviewToken(token, appId) : { ok: false };
}

async function authorizeGeneratedPreviewToken(
  token: string,
  appId: string,
): Promise<AuthorizedGeneratedPreview | { ok: false }> {
  const verification = verifyGeneratedPreviewCapability(token, appId);
  if (!verification.ok) return { ok: false };
  const data = await loadStoreAsync();
  const record = ((data.generatedApps ?? []) as GeneratedAppRecordWithRuntime[]).find(
    (entry) =>
      entry.id === verification.claims.appId &&
      entry.workspaceId === verification.claims.workspaceId,
  );
  if (!record) return { ok: false };
  const checkpoint = checkpointForPublish(record, verification.claims.checkpointId);
  if (!checkpoint || checkpoint.id !== verification.claims.checkpointId) return { ok: false };
  return { ok: true, claims: verification.claims, record, checkpoint };
}

function requirePreviewOrigin(c: Context) {
  if (!isPacketAgentPreviewOriginRequest(c)) {
    throw httpRouteError(404, "generated preview is only available on the isolated preview origin");
  }
}

function requirePrimaryOrigin(c: Context) {
  if (isPacketAgentPreviewOriginRequest(c)) throw httpRouteError(404, "not found");
}

function requireSamePreviewOriginBootstrap(c: Context) {
  const originHeader = c.req.header("origin");
  if (originHeader) {
    let normalized: string;
    try {
      normalized = normalizeHttpOrigin(originHeader, "preview session origin");
    } catch {
      throw httpRouteError(403, "cross-origin preview session requests are not allowed");
    }
    if (normalized !== resolvePacketAgentPreviewOrigin()) {
      throw httpRouteError(403, "cross-origin preview session requests are not allowed");
    }
  }
  const fetchSite = c.req.header("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    throw httpRouteError(403, "cross-origin preview session requests are not allowed");
  }
}

function interactivePreviewParentOrigin(c: Context): string {
  const configured = resolvePacketAgentAppOrigin();
  const candidate = normalizeHttpOrigin(
    c.req.header("origin") ?? configured ?? requestOrigin(c),
    "interactive preview parent origin",
  );
  if (configured && candidate !== configured) {
    throw httpRouteError(403, "interactive preview parent origin is not allowed");
  }
  return candidate;
}

// Import map injected into generated-app HTML so the browser can resolve
// the bare `react`, `react-dom`, and `react/jsx-runtime` specifiers that
// esbuild's automatic JSX runtime emits. Without this, the iframe throws
// "Failed to resolve module specifier 'react/jsx-runtime'" and the preview
// renders as broken/unstyled. A future Phase 3 will replace this with a
// proper Vite build cached per checkpoint that ships its own bundle.
function previewImportMap(nonce: string) {
  return `<script nonce="${nonce}" type="importmap">
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
}

// Transform .tsx/.ts files to executable JS at preview-serve time. The generated
// app's index.html loads /src/main.tsx as a module script; browsers reject the
// raw TS source (text/typescript MIME) so we transpile via esbuild on each request.
// HTML files get an importmap injected so the transformed JS can resolve bare
// react/react-dom imports against an ESM CDN.
async function transformPreviewFile(
  path: string,
  content: string,
  contentType: string,
  nonce: string,
  claims: GeneratedPreviewCapabilityClaims,
): Promise<{ content: string; contentType: string }> {
  if (/\.html?$/.test(path)) {
    // Inject the importmap right after the opening <head> tag so it resolves
    // before any module script loads. If there is no <head>, prepend before <html>.
    const importMap = previewImportMap(nonce);
    let injected = content;
    if (/<head\b[^>]*>/i.test(injected)) {
      injected = injected.replace(/<head\b[^>]*>/i, (m) => `${m}\n${importMap}`);
    } else if (/<html\b[^>]*>/i.test(injected)) {
      injected = injected.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${importMap}</head>`);
    } else {
      injected = `${importMap}\n${injected}`;
    }
    if (claims.scope === "interact" && claims.parentOrigin) {
      const bridge = `<script nonce="${nonce}">${generatedPreviewBridgeScript(
        claims.parentOrigin,
      )}</script>`;
      injected = /<\/body\s*>/i.test(injected)
        ? injected.replace(/<\/body\s*>/i, `${bridge}\n</body>`)
        : `${injected}\n${bridge}`;
    }
    injected = injected.replace(/<script\b(?![^>]*\bnonce\s*=)/gi, `<script nonce="${nonce}"`);
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

function generatedPreviewBootstrap(c: Context, appId: string) {
  const nonce = previewResponseNonce();
  const sessionPath = `${generatedPreviewCookiePath(appId)}preview-session`;
  const parentSources = previewBootstrapParentSources();
  c.header("Cache-Control", "no-store");
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      `frame-ancestors ${parentSources.join(" ")}`,
      "form-action 'none'",
      "object-src 'none'",
    ].join("; "),
  );
  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Opening PacketAgent preview</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #101418; color: #e7edf2; }
    main { max-width: 34rem; padding: 2rem; text-align: center; }
    p { color: #9ca9b3; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Opening isolated preview…</h1>
    <p id="status">Establishing a short-lived preview session.</p>
  </main>
  <script nonce="${nonce}">
    (() => {
      const status = document.getElementById("status");
      const token = new URLSearchParams(location.hash.slice(1)).get("token");
      if (!token || token.length > 4096) {
        status.textContent = "This preview link is missing, expired, or invalid.";
        return;
      }
      fetch(${JSON.stringify(sessionPath)}, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }).then(async (response) => {
        if (!response.ok) throw new Error("preview session rejected");
        history.replaceState(null, "", location.pathname + location.search);
        location.replace(location.pathname + location.search);
      }).catch(() => {
        history.replaceState(null, "", location.pathname + location.search);
        status.textContent = "This preview link is expired or invalid.";
      });
    })();
  </script>
</body>
</html>`);
}

function applyGeneratedPreviewDocumentHeaders(
  c: Context,
  claims: GeneratedPreviewCapabilityClaims,
  nonce: string,
) {
  const frameAncestors =
    claims.scope === "interact" && claims.parentOrigin ? claims.parentOrigin : "'none'";
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'self'",
      "connect-src 'self' https://cdn.jsdelivr.net",
      "font-src 'self' data:",
      "form-action 'self'",
      `frame-ancestors ${frameAncestors}`,
      "frame-src 'none'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "object-src 'none'",
      `script-src 'self' 'nonce-${nonce}' https://esm.sh https://cdn.jsdelivr.net`,
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
    ].join("; "),
  );
}

function applyGeneratedPreviewApiHeaders(c: Context) {
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Referrer-Policy", "no-referrer");
}

function previewResponseNonce(): string {
  return randomBytes(18).toString("base64");
}

function previewBootstrapParentSources(): string[] {
  const configured = resolvePacketAgentAppOrigin();
  return configured
    ? [configured]
    : [
        "http://localhost:7341",
        "http://127.0.0.1:7341",
        "http://localhost:8484",
        "http://127.0.0.1:8484",
      ];
}

function generatedPreviewBridgeScript(parentOrigin: string): string {
  return `(() => {
  const channel = "packetagent.preview.v1";
  const targetOrigin = ${JSON.stringify(parentOrigin)};
  let hoverActive = false;

  function selectorFor(element) {
    if (!(element instanceof Element)) return "";
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ").slice(0, 1024);
  }

  function boundedElementData(element) {
    const rect = element.getBoundingClientRect();
    return {
      selector: selectorFor(element),
      label: String(element.textContent || "").trim().slice(0, 120),
      rect: {
        left: Number(rect.left.toFixed(2)),
        top: Number(rect.top.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
      },
    };
  }

  function post(kind, detail) {
    window.parent.postMessage({ channel, kind, ...(detail || {}) }, targetOrigin);
  }

  document.addEventListener("mousemove", (event) => {
    const target = event.target;
    const armed = event.metaKey || event.ctrlKey;
    if (!armed || !(target instanceof Element) || target === document.body || target === document.documentElement) {
      if (hoverActive) post("clear");
      hoverActive = false;
      return;
    }
    hoverActive = true;
    post("hover", boundedElementData(target));
  }, { passive: true });
  document.addEventListener("mouseleave", () => {
    hoverActive = false;
    post("clear");
  });
  document.addEventListener("click", (event) => {
    if (!event.metaKey && !event.ctrlKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    event.preventDefault();
    event.stopPropagation();
    post("select", boundedElementData(target));
    hoverActive = false;
    post("clear");
  }, true);
  post("ready");
})();`;
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
  app.post("/app/generated-apps/:appId/preview-session", async (c) =>
    createGeneratedAppPreviewSession(c),
  );
  app.get("/app/generated-apps/:appId/api", async (c) => handleGeneratedAppRuntimeApi(c));
  app.get("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
  app.post("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
  app.put("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
  app.patch("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
  app.delete("/app/generated-apps/:appId/api/*", async (c) => handleGeneratedAppRuntimeApi(c));
}
