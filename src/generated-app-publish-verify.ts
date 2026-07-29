import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";
import type { GeneratedAppRuntimeModel, RuntimeSchemaEntity } from "./generated-app-runtime.js";
import { GENERATED_APP_PUBLISH_COMPOSE_FILE } from "./generated-app-publish-package.js";
import { verifyGeneratedAppReachability } from "./generated-app-publish-reachability.js";

export interface GeneratedAppPublishVerificationStep {
  id: string;
  status: "pass" | "fail";
  durationMs: number;
  detail: string;
}

export interface GeneratedAppPublishVerificationResult {
  schemaVersion: "packetagent.generated-app-compose-verification/v1";
  status: "pass" | "fail";
  publishRoot: string;
  projectName: string;
  port: number;
  startedAt: string;
  completedAt: string;
  steps: GeneratedAppPublishVerificationStep[];
  cleanup: "pass" | "fail";
}

interface RuntimeConfig {
  workspaceId: string;
  appId: string;
  checkpointId: string;
}

interface CommandResult {
  durationMs: number;
  stdout: string;
  stderr: string;
}

const MAX_RUNTIME_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export async function verifyGeneratedAppPublishPackage(
  publishRootInput: string,
): Promise<GeneratedAppPublishVerificationResult> {
  const publishRoot = resolve(publishRootInput);
  assertPublishDirectory(publishRoot);
  const config = readBoundedJson<RuntimeConfig>(
    resolve(publishRoot, "runtime-config.json"),
    256 * 1024,
  );
  const model = readBoundedJson<GeneratedAppRuntimeModel>(
    resolve(publishRoot, "runtime/runtime-model.json"),
    MAX_RUNTIME_FILE_BYTES,
  );
  const projectName = verificationProjectName(publishRoot, config.appId);
  const port = await availablePort();
  const startedAt = new Date().toISOString();
  const steps: GeneratedAppPublishVerificationStep[] = [];
  let cleanup: GeneratedAppPublishVerificationResult["cleanup"] = "pass";
  const composeArgs = ["compose", "-p", projectName, "-f", GENERATED_APP_PUBLISH_COMPOSE_FILE];
  const env = {
    ...process.env,
    PACKETAGENT_GENERATED_APP_PORT: String(port),
  };

  try {
    await commandStep(steps, "compose-config", publishRoot, env, [
      ...composeArgs,
      "config",
      "--quiet",
    ]);
    await commandStep(
      steps,
      "compose-build-start-wait",
      publishRoot,
      env,
      [...composeArgs, "up", "--build", "--wait", "--wait-timeout", "180"],
      240_000,
    );
    const portResult = await commandStep(steps, "compose-port", publishRoot, env, [
      ...composeArgs,
      "port",
      "generated-app",
      "8080",
    ]);
    const discoveredPort = parseComposePort(portResult.stdout);
    if (discoveredPort !== port) {
      throw new Error(`compose mapped host port ${discoveredPort}; expected ${port}`);
    }

    const baseUrl = `http://127.0.0.1:${port}`;
    await probeStep(steps, "reachability-contract", async () => {
      const reachability = await verifyGeneratedAppReachability(publishRoot, baseUrl);
      if (reachability.status !== "pass") {
        const failure = reachability.steps.find((step) => step.status === "fail");
        throw new Error(
          `reachability ${failure?.code ?? "failed"}: ${failure?.detail ?? "unknown failure"}`,
        );
      }
      return "DNS, TCP, health, package identity, and app-root reachability passed.";
    });
    await probeStep(steps, "health-live", async () => {
      const body = await fetchJson(`${baseUrl}/health/live`);
      if (body.status !== "live") throw new Error("liveness status was not live");
      return "GET /health/live returned live.";
    });
    await probeStep(steps, "health-ready", async () => {
      const body = await fetchJson(`${baseUrl}/health/ready`);
      if (body.status !== "ready" || body.checkpointId !== config.checkpointId) {
        throw new Error("readiness identity did not match the package checkpoint");
      }
      return "GET /health/ready returned the expected checkpoint.";
    });
    await probeStep(steps, "static-root", async () => {
      const response = await fetchWithTimeout(`${baseUrl}/`);
      const body = await response.text();
      if (!response.ok || !body.toLowerCase().includes("<!doctype html")) {
        throw new Error("app root did not return generated HTML");
      }
      return "GET / returned generated HTML.";
    });

    const createdId = await verifyCrud(steps, baseUrl, config.appId, model);
    await commandStep(steps, "compose-stop", publishRoot, env, [...composeArgs, "stop"], 60_000);
    await commandStep(steps, "compose-restart-wait", publishRoot, env, [
      ...composeArgs,
      "start",
      "--wait",
      "--wait-timeout",
      "60",
    ]);
    await probeStep(steps, "sqlite-restart-persistence", async () => {
      const entity = primaryEntity(model);
      const response = await fetchWithTimeout(
        `${generatedApiBase(baseUrl, config.appId, entity.name)}/${encodeURIComponent(createdId)}`,
      );
      const body = (await response.json()) as Record<string, unknown> | null;
      if (!response.ok || body?.id !== createdId) {
        throw new Error("created record was not present after the container restart");
      }
      return "Created record remained in the named SQLite volume after restart.";
    });
    await probeStep(steps, "crud-delete", async () => {
      const entity = primaryEntity(model);
      const response = await fetchWithTimeout(
        `${generatedApiBase(baseUrl, config.appId, entity.name)}/${encodeURIComponent(createdId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(`DELETE returned ${response.status}`);
      return "Generated CRUD archive completed.";
    });
  } catch (error) {
    steps.push({
      id: "verification",
      status: "fail",
      durationMs: 0,
      detail: safeDetail(error),
    });
  } finally {
    try {
      await commandStep(
        steps,
        "compose-down-cleanup",
        publishRoot,
        env,
        [...composeArgs, "down", "--volumes", "--remove-orphans", "--rmi", "local"],
        60_000,
      );
    } catch {
      cleanup = "fail";
    }
  }

  return {
    schemaVersion: "packetagent.generated-app-compose-verification/v1",
    status: steps.every((step) => step.status === "pass") && cleanup === "pass" ? "pass" : "fail",
    publishRoot,
    projectName,
    port,
    startedAt,
    completedAt: new Date().toISOString(),
    steps,
    cleanup,
  };
}

async function verifyCrud(
  steps: GeneratedAppPublishVerificationStep[],
  baseUrl: string,
  appId: string,
  model: GeneratedAppRuntimeModel,
): Promise<string> {
  const entity = primaryEntity(model);
  const apiBase = generatedApiBase(baseUrl, appId, entity.name);
  await probeStep(steps, "crud-list", async () => {
    const response = await fetchWithTimeout(apiBase);
    const body = await response.json();
    if (!response.ok || !Array.isArray(body))
      throw new Error("generated list did not return an array");
    return `Generated ${entity.name} list returned ${body.length} record(s).`;
  });
  const createBody = bodyForEntity(entity);
  let createdId = "";
  await probeStep(steps, "crud-create", async () => {
    const response = await fetchWithTimeout(apiBase, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (response.status !== 201 || typeof body.id !== "string") {
      throw new Error(`generated create returned ${response.status}`);
    }
    createdId = body.id;
    return `Generated ${entity.name} create returned 201.`;
  });
  await probeStep(steps, "crud-update", async () => {
    const editable = entity.editableFields.find((field) => field !== "id") || "name";
    const response = await fetchWithTimeout(`${apiBase}/${encodeURIComponent(createdId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [editable]: "PacketAgent verification updated" }),
    });
    if (!response.ok) throw new Error(`generated update returned ${response.status}`);
    return `Generated ${entity.name} update returned ${response.status}.`;
  });
  return createdId;
}

async function commandStep(
  steps: GeneratedAppPublishVerificationStep[],
  id: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  const started = Date.now();
  try {
    const result = await runCommand("docker", args, cwd, env, timeoutMs);
    steps.push({
      id,
      status: "pass",
      durationMs: result.durationMs,
      detail: boundedOutput(result.stdout || result.stderr || "Command completed."),
    });
    return result;
  } catch (error) {
    steps.push({
      id,
      status: "fail",
      durationMs: Date.now() - started,
      detail: safeDetail(error),
    });
    throw error;
  }
}

async function probeStep(
  steps: GeneratedAppPublishVerificationStep[],
  id: string,
  probe: () => Promise<string>,
): Promise<void> {
  const started = Date.now();
  try {
    const detail = await probe();
    steps.push({ id, status: "pass", durationMs: Date.now() - started, detail });
  } catch (error) {
    steps.push({
      id,
      status: "fail",
      durationMs: Date.now() - started,
      detail: safeDetail(error),
    });
    throw error;
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      if (outputBytes >= MAX_COMMAND_OUTPUT_BYTES) return;
      const remaining = MAX_COMMAND_OUTPUT_BYTES - outputBytes;
      const bounded = chunk.subarray(0, remaining);
      target.push(bounded);
      outputBytes += bounded.length;
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const result = {
        durationMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} exceeded ${timeoutMs}ms`));
      } else if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${code}: ${boundedOutput(result.stderr || result.stdout)}`,
          ),
        );
      } else {
        resolvePromise(result);
      }
    });
  });
}

function generatedApiBase(baseUrl: string, appId: string, entityName: string): string {
  return `${baseUrl}/api/app/generated-apps/${encodeURIComponent(appId)}/api/${encodeURIComponent(entityName)}s`;
}

function primaryEntity(model: GeneratedAppRuntimeModel): RuntimeSchemaEntity {
  const entity =
    model.schema.find((candidate) => candidate.name === model.primaryEntity) || model.schema[0];
  if (!entity) throw new Error("runtime model contains no schema entities");
  return entity;
}

function bodyForEntity(entity: RuntimeSchemaEntity): Record<string, string | number | boolean> {
  const fields = new Set([...entity.requiredFields, ...entity.editableFields]);
  fields.delete("id");
  const body: Record<string, string | number | boolean> = {};
  for (const fieldName of fields) {
    const field = entity.fields.find((candidate) => candidate.name === fieldName);
    body[fieldName] =
      field?.type === "number"
        ? 1
        : field?.type === "boolean"
          ? true
          : `PacketAgent verification ${fieldName}`;
  }
  return body;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return body;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

function verificationProjectName(publishRoot: string, appId: string): string {
  const suffix = createHash("sha256")
    .update(`${publishRoot}:${appId}:${process.pid}:${Date.now()}`)
    .digest("hex")
    .slice(0, 10);
  const app =
    appId
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .slice(0, 24) || "app";
  return `packetagent-verify-${app}-${suffix}`;
}

function parseComposePort(output: string): number {
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/:(\d+)$/);
    const port = Number(match?.[1]);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return port;
  }
  throw new Error(`docker compose returned an invalid port mapping: ${boundedOutput(output)}`);
}

function assertPublishDirectory(publishRoot: string): void {
  const composePath = resolve(publishRoot, GENERATED_APP_PUBLISH_COMPOSE_FILE);
  if (!existsSync(composePath) || !statSync(composePath).isFile()) {
    throw new Error(
      `${basename(publishRoot)} does not contain ${GENERATED_APP_PUBLISH_COMPOSE_FILE}`,
    );
  }
}

function readBoundedJson<T>(filePath: string, maxBytes: number): T {
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > maxBytes) {
    throw new Error(`${basename(filePath)} exceeds the verification read limit`);
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function safeDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return boundedOutput(
    detail
      .replace(/\b(sk|pk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
      .replace(/(password|secret|token|api[_-]?key)=([^\s&]+)/gi, "$1=[REDACTED]"),
  );
}

function boundedOutput(value: string): string {
  const compact = value.trim() || "Command completed without output.";
  return compact.length <= 8_192 ? compact : `${compact.slice(0, 8_192)}…[truncated]`;
}
