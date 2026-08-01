import { AppBuilderCheckStatus, smokeStatusFromChecks } from "./smoke.js";
import { buildAppBuilderDraft } from "./draft.js";
import { inspectAppIterationTools } from "../../app-iteration-tools.js";
import { type AppIterationFileReview } from "../../app-iteration-service.js";
import {
  type GeneratedAppCheckpointRecord,
  type GeneratedAppRecord,
} from "../../packetagent-store.js";
import {
  type GeneratedAppRuntimeArtifactRecord,
  type GeneratedAppSourceFileRecord,
  type GeneratedAppSourceFileSummary,
  summarizeGeneratedAppSourceFiles,
} from "../../generated-app-runtime.js";
import { type GeneratedFile } from "../../codegen/llm-author.js";
import { type ModelRoutingPresetId } from "../../model-routing-presets.js";

export type AppBuilderDraftContract = ReturnType<typeof buildAppBuilderDraft>;

export type AppDraftSource = "llm" | "template" | "llm-filetree";

export type GeneratedAppCheckpointWithRuntime = GeneratedAppCheckpointRecord & {
  runtimeArtifact?: GeneratedAppRuntimeArtifactRecord;
  sourceFiles?: GeneratedAppSourceFileRecord[];
  codegenSource?: AppDraftSource;
};

export type GeneratedAppRecordWithRuntime = GeneratedAppRecord & {
  runtimeArtifact?: GeneratedAppRuntimeArtifactRecord;
  sourceFiles?: GeneratedAppSourceFileRecord[];
  codegenSource?: AppDraftSource;
  checkpoints?: GeneratedAppCheckpointWithRuntime[];
};

interface GeneratedAppWorkspaceManifest {
  version: "generated-app-workspace.v1";
  workspace: { id: string; slug: string };
  app: { id: string; slug: string; name: string };
  checkpoint: { id: string; source?: GeneratedAppCheckpointRecord["source"]; createdAt: string };
  artifact: {
    entrypoint: string;
    renderedAt: string;
    files: GeneratedAppSourceFileSummary[];
  };
}

export interface GeneratedAppWorkspaceSummary {
  id: string;
  slug: string;
  path: string;
  appPath: string;
  checkpointPath: string;
  manifest: {
    path: string;
    version: GeneratedAppWorkspaceManifest["version"];
    fileCount: number;
    totalBytes: number;
    entrypoint: string;
    renderedAt: string;
    checkpointId: string;
  };
}

type AppBuilderIterationTargetKind =
  | "app"
  | "page"
  | "component"
  | "data_entity"
  | "api_route"
  | "auth"
  | "smoke"
  | "config"
  | "file"
  | "agent"
  | "tool";

export type AppBuilderIterationDiffStatus = "generated" | "pending" | "applied" | "blocked";

export interface AppBuilderIterationTarget {
  id: string;
  kind: AppBuilderIterationTargetKind;
  label: string;
  path?: string;
  selector?: string;
}

export interface AppIterationRouteRequest {
  appId?: string;
  checkpointId?: string;
  draft?: AppBuilderDraftContract;
  draftSource?: AppDraftSource;
  fileTree?: GeneratedFile[];
  target?: AppBuilderIterationTarget;
  prompt?: string;
  agentId?: string;
  previewUrl?: string;
  selectedContext?: unknown;
  errorContext?: { source?: "build" | "runtime" | "smoke"; message?: string; prompt?: string };
  mode?: string;
  preset?: ModelRoutingPresetId;
  sourceError?: {
    source: "build" | "runtime" | "smoke";
    message: string;
    prompt: string;
  };
}

export interface AppIterationApplyRouteRequest {
  appId?: string;
  checkpointId?: string;
  diffId?: string;
  target?: AppBuilderIterationTarget;
  files?: Array<{ path: string; changeType: string; summary: string; diff: string }>;
  diff?: AppIterationRouteResult;
  changeSet?: AppIterationRouteResult;
  changeSetId?: string;
  draft?: AppBuilderDraftContract;
  runBuild?: boolean;
  runSmoke?: boolean;
  refreshPreview?: boolean;
  previewUrl?: string;
}

export interface AppPublishRouteRequest {
  target?: "app" | "agent" | "bundle";
  appId?: string;
  agentId?: string;
  checkpointId?: string;
  visibility?: "private" | "public";
  localPublishRoot?: string;
  publicBaseUrl?: string;
  privateBaseUrl?: string;
  runHealth?: boolean;
  runSmoke?: boolean;
  exportCompose?: boolean;
}

export interface AppPublishRollbackRouteRequest {
  appId?: string;
  agentId?: string;
  targetPublishId?: string;
  reason?: string;
}

export interface AppIterationRouteResult {
  id: string;
  appId?: string;
  checkpointId?: string;
  target: AppBuilderIterationTarget;
  prompt: string;
  summary: string;
  status: AppBuilderIterationDiffStatus;
  files: AppIterationDiffFile[];
  fileReview?: AppIterationFileReview[];
  sourceDiffFiles?: AppIterationDiffFile[];
  sourceFiles?: ReturnType<typeof summarizeGeneratedAppSourceFiles>;
  fileTree?: GeneratedFile[];
  draftSource?: AppDraftSource;
  validationErrors?: string[];
  artifact?: {
    entrypoint?: string;
    renderedAt?: string;
    files: ReturnType<typeof summarizeGeneratedAppSourceFiles>;
  };
  draft?: AppBuilderDraftContract;
  preview?: {
    url?: string;
    refreshedAt?: string;
    status: AppBuilderCheckStatus;
    message: string;
  };
  logs: Array<{ at: string; level: "info" | "warn" | "error"; message: string }>;
  smoke?: ReturnType<typeof smokeStatusFromChecks>;
  errorFix?: {
    source: "build" | "runtime" | "smoke";
    message: string;
    prompt: string;
  };
  tools?: ReturnType<typeof inspectAppIterationTools>;
}

export type AppIterationDiffFile = {
  path: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  summary: string;
  diff: string;
  source?: "draft" | "runtime";
  beforeSha256?: string;
  afterSha256?: string;
  beforeSize?: number;
  afterSize?: number;
  role?: GeneratedAppSourceFileRecord["role"];
};
