import type {
  ActivationChecklistItem,
  ActivationChecklistItemKey,
  ActivationRiskLevel,
  ActivationStatusDto,
} from "./domain";

export interface ActivationChecklistViewItem {
  key: ActivationChecklistItemKey;
  label: string;
  description: string;
  completed: boolean;
  completedAt?: string;
}

export interface ActivationSummaryCardViewModel {
  title: string;
  progressPercent: number;
  progressLabel: string;
  stageLabel: string;
  riskLabel: string;
  riskLevel: ActivationRiskLevel;
  items: ActivationChecklistViewItem[];
  nextRecommendedAction: string | null;
}

export function buildActivationSummaryCard(
  status: ActivationStatusDto,
): ActivationSummaryCardViewModel {
  const items = status.checklist.map(toChecklistViewItem);
  const completedCount = items.filter((item) => item.completed).length;
  const progressPercent =
    items.length === 0 ? 0 : Math.round((completedCount / items.length) * 100);

  return {
    title: "Setup checklist",
    progressPercent,
    progressLabel: `${completedCount}/${items.length} completed`,
    stageLabel: humanizeStage(status.stage),
    riskLabel: humanizeRisk(status.risk.level),
    riskLevel: status.risk.level,
    items,
    nextRecommendedAction: items.find((item) => !item.completed)?.description ?? null,
  };
}

function toChecklistViewItem(item: ActivationChecklistItem): ActivationChecklistViewItem {
  return {
    key: item.key,
    label: CHECKLIST_LABELS[item.key].label,
    description: CHECKLIST_LABELS[item.key].description,
    completed: item.completed,
    completedAt: item.completedAt,
  };
}

function humanizeStage(stage: ActivationStatusDto["stage"]): string {
  return stage.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function humanizeRisk(level: ActivationRiskLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

const CHECKLIST_LABELS: Record<ActivationChecklistItemKey, { label: string; description: string }> =
  {
    brief_captured: {
      label: "Brief captured",
      description: "Capture the initial implementation brief.",
    },
    requirements_defined: {
      label: "Requirements defined",
      description: "Document the scope and the implementation plan.",
    },
    implementation_started: {
      label: "Implementation started",
      description: "Start building against the agreed scope.",
    },
    validation_completed: {
      label: "Validation completed",
      description: "Collect test and validation evidence.",
    },
    release_confirmed: {
      label: "Release confirmed",
      description: "Confirm the work is released and live.",
    },
  };
