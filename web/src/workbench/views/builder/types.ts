import { api } from "@/lib/api";
import type {
  AppBuilderDraft,
  AppBuilderDraftSource,
  AppBuilderGeneratedFile,
  AppBuilderIterationResult,
  AppBuilderIterationTarget,
  AppBuilderPublishState,
  AppBuilderSmokeBuildStatus,
  AppBuilderSourceFileSummary,
  AppBuilderWorkspaceSummary,
} from "@/lib/types";

export interface SelectedElement {
  selector: string;
  label: string;
}

export type ChatBody =
  | { kind: "text"; text: string }
  | { kind: "steps"; steps: string[] }
  | { kind: "prose"; text: string }
  | { kind: "plan"; draft: AppBuilderDraft }
  | { kind: "diff"; iteration: AppBuilderIterationResult }
  | { kind: "validation-errors"; errors: string[]; canFix: boolean }
  | { kind: "status"; text: string; tone: "info" | "warn" | "error" | "ok" };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  body: ChatBody;
  streaming?: boolean;
  /**
   * Checkpoint id this message produced (set after approve/applyIteration succeeds).
   * Powers the per-message "Revert to here" affordance in `ThreadMessage`.
   */
  checkpointId?: string;
}

export type Mode =
  | "empty"
  | "agent"
  | "drafting"
  | "drafted"
  | "applying"
  | "applied"
  | "iterating";
export type BuilderKind = "app" | "agent";

export interface BuilderState {
  draft: AppBuilderDraft | null;
  draftSource: AppBuilderDraftSource | null;
  generatedFiles: AppBuilderGeneratedFile[];
  appId: string | null;
  checkpointId: string | null;
  previewUrl: string | null;
  smoke: AppBuilderSmokeBuildStatus | null;
  iteration: AppBuilderIterationResult | null;
  sourceFiles: AppBuilderSourceFileSummary[];
  workspace: AppBuilderWorkspaceSummary | null;
}

export type IterationTargetOption = AppBuilderIterationTarget & { group: string };
export type PublishRollbackAction = AppBuilderPublishState["rollbackActions"][number];
export type PublishRollbackBody = NonNullable<Parameters<typeof api.rollbackBuilderPublish>[1]> & {
  targetPublishId?: string;
};
