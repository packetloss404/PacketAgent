import { resolve as resolvePath } from "node:path";
import {
  closeBrowserSession,
  ensureArtifactDir,
  getOrCreateBrowserSession,
} from "./browser-runtime.js";
import { browserAuthorization, inputAuthorization } from "./authorization.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

function browserEffect(
  classification: "read_only" | "idempotent_mutation" | "non_replayable_mutation",
  operation: string,
) {
  return {
    describe: () => ({ classification, operation }),
  };
}

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function ensureRunId(runId: string | undefined): string | null {
  return runId ?? null;
}

function workerBrowserBoundary(ctx: ToolContext): ToolResult | null {
  return ctx.worker
    ? {
        ok: false,
        error:
          "Autonomous Worker browser access is disabled until its browser driver enforces pinned network destinations.",
      }
    : null;
}

function ensureSafeUrl(url: string): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `invalid url: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `protocol ${parsed.protocol} not allowed; must be http or https` };
  }
  if (BLOCKED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { ok: false, error: `host ${parsed.hostname} is blocked from browser fetch` };
  }
  return { ok: true, url: parsed };
}

export const browserGotoTool: ToolDefinition = {
  name: "browser_goto",
  description:
    "Navigate the run's headless browser to a URL. Subsequent browser_* tools operate on this page.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", format: "uri" },
      waitUntil: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        default: "domcontentloaded",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  side: "exec",
  effect: browserEffect("non_replayable_mutation", "browser.navigate"),
  authorization: inputAuthorization((input: Record<string, unknown>) => ({
    verb: "NAVIGATE",
    effect: "execute",
    resources: [typeof input.url === "string" ? input.url : ""],
  })),
  timeoutMs: 30_000,
  async handle(input, ctx) {
    const workerBoundary = workerBrowserBoundary(ctx);
    if (workerBoundary) return workerBoundary;
    const runId = ensureRunId(ctx.runId);
    if (!runId) return { ok: false, error: "browser tools require a runId on the tool context" };
    const { url, waitUntil = "domcontentloaded" } = input as {
      url: string;
      waitUntil?: "load" | "domcontentloaded" | "networkidle";
    };
    const guard = ensureSafeUrl(url);
    if (!guard.ok) return { ok: false, error: guard.error };
    const session = await getOrCreateBrowserSession(runId);
    if (!session)
      return {
        ok: false,
        error: "Playwright is not installed or failed to launch. Install playwright + browsers.",
      };
    try {
      await session.page.goto(guard.url.toString(), { waitUntil });
      const title = await session.page.title();
      return { ok: true, output: { url: session.page.url(), title } };
    } catch (error) {
      return { ok: false, error: `goto failed: ${(error as Error).message}` };
    }
  },
};

export const browserClickTool: ToolDefinition = {
  name: "browser_click",
  description: "Click an element on the current browser page by CSS selector.",
  inputSchema: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"],
    additionalProperties: false,
  },
  side: "exec",
  effect: browserEffect("non_replayable_mutation", "browser.click"),
  authorization: browserAuthorization("CLICK", "execute"),
  timeoutMs: 15_000,
  async handle(input, ctx) {
    const workerBoundary = workerBrowserBoundary(ctx);
    if (workerBoundary) return workerBoundary;
    const runId = ensureRunId(ctx.runId);
    if (!runId) return { ok: false, error: "browser tools require a runId" };
    const session = await getOrCreateBrowserSession(runId);
    if (!session) return { ok: false, error: "Playwright is not installed or failed to launch." };
    const { selector } = input as { selector: string };
    try {
      await session.page.click(selector);
      return { ok: true, output: { clicked: selector } };
    } catch (error) {
      return { ok: false, error: `click failed: ${(error as Error).message}` };
    }
  },
};

export const browserFillTool: ToolDefinition = {
  name: "browser_fill",
  description: "Fill a form input on the current browser page.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      value: { type: "string" },
    },
    required: ["selector", "value"],
    additionalProperties: false,
  },
  side: "exec",
  effect: browserEffect("non_replayable_mutation", "browser.fill"),
  authorization: browserAuthorization("FILL", "execute"),
  timeoutMs: 15_000,
  async handle(input, ctx) {
    const workerBoundary = workerBrowserBoundary(ctx);
    if (workerBoundary) return workerBoundary;
    const runId = ensureRunId(ctx.runId);
    if (!runId) return { ok: false, error: "browser tools require a runId" };
    const session = await getOrCreateBrowserSession(runId);
    if (!session) return { ok: false, error: "Playwright is not installed or failed to launch." };
    const { selector, value } = input as { selector: string; value: string };
    try {
      await session.page.fill(selector, value);
      return { ok: true, output: { filled: selector } };
    } catch (error) {
      return { ok: false, error: `fill failed: ${(error as Error).message}` };
    }
  },
};

export const browserExtractTool: ToolDefinition = {
  name: "browser_extract",
  description: "Extract text content from elements matching a CSS selector.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100, default: 25 },
    },
    required: ["selector"],
    additionalProperties: false,
  },
  side: "exec",
  effect: browserEffect("read_only", "browser.extract"),
  authorization: browserAuthorization("EXTRACT", "read"),
  timeoutMs: 15_000,
  async handle(input, ctx) {
    const workerBoundary = workerBrowserBoundary(ctx);
    if (workerBoundary) return workerBoundary;
    const runId = ensureRunId(ctx.runId);
    if (!runId) return { ok: false, error: "browser tools require a runId" };
    const session = await getOrCreateBrowserSession(runId);
    if (!session) return { ok: false, error: "Playwright is not installed or failed to launch." };
    const { selector, limit = 25 } = input as { selector: string; limit?: number };
    try {
      const items = await session.page.$$eval(selector, (els: Element[]) =>
        els.map((el: Element) => (el.textContent ?? "").trim()).filter(Boolean),
      );
      return { ok: true, output: { count: items.length, items: items.slice(0, limit) } };
    } catch (error) {
      return { ok: false, error: `extract failed: ${(error as Error).message}` };
    }
  },
};

export const browserScreenshotTool: ToolDefinition = {
  name: "browser_screenshot",
  description:
    "Capture a PNG screenshot of the current browser page; saves to the run's artifact dir and returns the relative path.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", default: "page.png" },
      fullPage: { type: "boolean", default: false },
    },
    additionalProperties: false,
  },
  side: "exec",
  effect: browserEffect("non_replayable_mutation", "browser.screenshot"),
  authorization: browserAuthorization("CAPTURE", "execute"),
  timeoutMs: 30_000,
  async handle(input, ctx) {
    const workerBoundary = workerBrowserBoundary(ctx);
    if (workerBoundary) return workerBoundary;
    const runId = ensureRunId(ctx.runId);
    if (!runId) return { ok: false, error: "browser tools require a runId" };
    const session = await getOrCreateBrowserSession(runId);
    if (!session) return { ok: false, error: "Playwright is not installed or failed to launch." };
    const { name = "page.png", fullPage = false } = input as { name?: string; fullPage?: boolean };
    const safeName = /^[A-Za-z0-9._-]+\.(png|jpg|jpeg)$/.test(name) ? name : "page.png";
    const dir = ensureArtifactDir(runId);
    const path = resolvePath(dir, safeName);
    try {
      await session.page.screenshot({ path, fullPage });
      const relative = `data/artifacts/${runId}/${safeName}`;
      return {
        ok: true,
        output: { path: relative, fullPage, url: session.page.url() },
        artifacts: [{ path: relative, bytes: 0, kind: "image/png" }],
      };
    } catch (error) {
      return { ok: false, error: `screenshot failed: ${(error as Error).message}` };
    }
  },
};

export const browserCloseSessionTool: ToolDefinition = {
  name: "browser_close",
  description:
    "Close the run's browser session. Sessions auto-close at run end; only call this if you need to free memory mid-run.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  side: "exec",
  effect: browserEffect("idempotent_mutation", "browser.close"),
  authorization: browserAuthorization("CLOSE", "execute"),
  async handle(_input, ctx) {
    const workerBoundary = workerBrowserBoundary(ctx);
    if (workerBoundary) return workerBoundary;
    const runId = ensureRunId(ctx.runId);
    if (!runId) return { ok: false, error: "browser tools require a runId" };
    await closeBrowserSession(runId);
    return { ok: true, output: { closed: true } };
  },
};

export const BROWSER_TOOLS: ToolDefinition[] = [
  browserGotoTool,
  browserClickTool,
  browserFillTool,
  browserExtractTool,
  browserScreenshotTool,
  browserCloseSessionTool,
];
