import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { openGeneratedAppSqliteRuntime } from "./sqlite.js";
import type { GeneratedAppRuntimeModel } from "../generated-app-runtime.js";

interface WorkerConfig {
  appId: string;
  workspaceId: string;
  model: GeneratedAppRuntimeModel;
  runtimeRoot?: string;
  dbPath?: string;
}

const MAX_REQUEST_BYTES = 1024 * 1024;

let runtime: ReturnType<typeof openGeneratedAppSqliteRuntime> | null = null;
let server: ReturnType<typeof createServer> | null = null;

start().catch((error) => {
  sendParentMessage({
    type: "error",
    error: error instanceof Error ? error.message : String(error),
  });
  shutdown().finally(() => process.exit(1));
});

async function start(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("generated app runtime worker config path missing");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as WorkerConfig;
  runtime = openGeneratedAppSqliteRuntime(config);

  server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "generated app runtime request failed";
      writeJson(response, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  if (!address?.port) throw new Error("generated app runtime worker did not bind a port");
  sendParentMessage({ type: "ready", port: address.port, pid: process.pid });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!runtime) throw new Error("generated app runtime is not initialized");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const result = runtime.handleRequest({
    method: request.method ?? "GET",
    path: `${url.pathname}${url.search}`.replace(/^\/+/, ""),
    body: await readJsonBody(request),
  });
  writeJson(response, result.status, result.body);
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  const contentType = request.headers["content-type"] ?? "";
  if (!String(contentType).toLowerCase().includes("application/json")) return undefined;

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES)
      throw new Error("generated app runtime request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (response.req.method?.toUpperCase() === "HEAD") {
    response.end();
    return;
  }
  response.end(JSON.stringify(body));
}

function sendParentMessage(message: Record<string, unknown>): void {
  if (typeof process.send === "function") process.send(message);
}

async function shutdown(): Promise<void> {
  const currentServer = server;
  const currentRuntime = runtime;
  server = null;
  runtime = null;
  await new Promise<void>((resolve) => {
    if (!currentServer) {
      resolve();
      return;
    }
    currentServer.close(() => resolve());
  });
  currentRuntime?.close();
}

process.once("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
