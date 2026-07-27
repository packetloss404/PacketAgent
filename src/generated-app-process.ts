import type {
  GeneratedAppRuntimeArtifactRecord,
  GeneratedAppSourceFileRecord,
} from "./generated-app-runtime.js";

export type GeneratedAppRuntimeMode = "static" | "live";
export type GeneratedAppProcessStatus = "not_started" | "running" | "unavailable";

export interface GeneratedAppPreviewRuntimeReadiness {
  version: "generated-app-preview-runtime-v1";
  mode: GeneratedAppRuntimeMode;
  live: boolean;
  status: "ready" | "missing-entrypoint";
  entrypoint: string;
  servedBy: "packetagent-static-workspace";
  process: {
    status: GeneratedAppProcessStatus;
    cwd: string;
    command: string;
    pid?: number;
    startedAt?: string;
  };
}

export interface GeneratedAppPreviewFileResult {
  file: GeneratedAppSourceFileRecord;
  path: string;
  readiness: GeneratedAppPreviewRuntimeReadiness;
}

export interface GeneratedAppPreviewFileMiss {
  path: string;
  readiness: GeneratedAppPreviewRuntimeReadiness;
}

const DEFAULT_PROCESS_COMMAND = "npm run dev -- --host 127.0.0.1";

export function buildGeneratedAppPreviewReadiness(input: {
  appId: string;
  workspaceId: string;
  checkpointId: string;
  artifact: GeneratedAppRuntimeArtifactRecord;
  live?: boolean;
  process?: Partial<GeneratedAppPreviewRuntimeReadiness["process"]>;
}): GeneratedAppPreviewRuntimeReadiness {
  const entrypoint = normalizeWorkspaceAssetPath(input.artifact.entrypoint) || "index.html";
  const hasEntrypoint = input.artifact.files.some((file) => normalizeWorkspaceAssetPath(file.path) === entrypoint);

  return {
    version: "generated-app-preview-runtime-v1",
    mode: input.live ? "live" : "static",
    live: Boolean(input.live),
    status: hasEntrypoint ? "ready" : "missing-entrypoint",
    entrypoint,
    servedBy: "packetagent-static-workspace",
    process: {
      status: input.live ? "running" : "not_started",
      cwd: `generated://${input.workspaceId}/${input.appId}/${input.checkpointId}`,
      command: DEFAULT_PROCESS_COMMAND,
      ...input.process,
    },
  };
}

export function resolveGeneratedAppPreviewFile(input: {
  appId: string;
  workspaceId: string;
  checkpointId: string;
  artifact: GeneratedAppRuntimeArtifactRecord;
  requestedPath?: string;
}): GeneratedAppPreviewFileResult | GeneratedAppPreviewFileMiss {
  const readiness = buildGeneratedAppPreviewReadiness(input);
  const hasExplicitPath = Boolean(input.requestedPath?.trim());
  const requestedPath = normalizeWorkspaceAssetPath(input.requestedPath || "");
  const path = hasExplicitPath ? requestedPath : readiness.entrypoint;
  const file = input.artifact.files.find((entry) => normalizeWorkspaceAssetPath(entry.path) === path);

  if (file) return { file, path, readiness };
  return { path, readiness };
}

export function normalizeWorkspaceAssetPath(path: string): string {
  const decoded = safeDecode(path)
    .split("?")[0]
    .split("#")[0]
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const parts = decoded.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) return "";
  return parts.join("/");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
