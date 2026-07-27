import { mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export interface BrowserPage {
  goto(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  innerText(selector: string): Promise<string>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<Buffer | void>;
  $$eval<T>(selector: string, fn: (els: Element[]) => T): Promise<T>;
}

export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  launchContext(): Promise<BrowserContext>;
  shutdown(): Promise<void>;
}

interface PlaywrightModule {
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<{
      newContext(opts?: Record<string, unknown>): Promise<BrowserContext>;
      close(): Promise<void>;
    }>;
  };
}

let cachedDriver: BrowserDriver | null = null;
let driverError: Error | null = null;

const PROJECT_ROOT = process.cwd();
const ARTIFACT_ROOT = resolvePath(PROJECT_ROOT, "data", "artifacts");

export function ensureArtifactDir(runId: string): string {
  const dir = resolvePath(ARTIFACT_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function getBrowserDriver(): Promise<BrowserDriver | null> {
  if (process.env.PLAYWRIGHT_DISABLED === "1") return null;
  if (cachedDriver) return cachedDriver;
  if (driverError) return null;
  let mod: PlaywrightModule;
  try {
    mod = (await import("playwright")) as unknown as PlaywrightModule;
  } catch (error) {
    driverError = error as Error;
    return null;
  }
  let browser: Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>>;
  try {
    browser = await mod.chromium.launch({ headless: true });
  } catch (error) {
    driverError = error as Error;
    return null;
  }
  cachedDriver = {
    async launchContext(): Promise<BrowserContext> {
      const context = await browser.newContext({
        userAgent: "PacketAgent/1.0 (sandboxed)",
        viewport: { width: 1280, height: 800 },
      });
      return context as unknown as BrowserContext;
    },
    async shutdown(): Promise<void> {
      await browser.close();
      cachedDriver = null;
    },
  };
  return cachedDriver;
}

const sessionByRun = new Map<string, { context: BrowserContext; page: BrowserPage }>();

export async function getOrCreateBrowserSession(runId: string): Promise<{ context: BrowserContext; page: BrowserPage } | null> {
  const existing = sessionByRun.get(runId);
  if (existing) return existing;
  const driver = await getBrowserDriver();
  if (!driver) return null;
  const context = await driver.launchContext();
  const page = await context.newPage();
  const session = { context, page };
  sessionByRun.set(runId, session);
  return session;
}

export async function closeBrowserSession(runId: string): Promise<void> {
  const session = sessionByRun.get(runId);
  if (!session) return;
  sessionByRun.delete(runId);
  try { await session.context.close(); } catch { /* ignore */ }
}

export async function shutdownAllBrowserSessions(): Promise<void> {
  const ids = [...sessionByRun.keys()];
  await Promise.all(ids.map(closeBrowserSession));
  if (cachedDriver) {
    try { await cachedDriver.shutdown(); } catch { /* ignore */ }
    cachedDriver = null;
  }
}

export function browserDriverError(): string | null {
  return driverError ? driverError.message : null;
}
