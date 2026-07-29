import {
  ACTIVATION_MILESTONE_ORDER,
  type ActivationMilestoneKey,
  type ActivationMilestoneRecord,
  type ActivationSignalSnapshot,
  type ActivationStage,
} from "./domain";

export function detectMilestones(
  input: ActivationSignalSnapshot,
  prior: ReadonlyArray<ActivationMilestoneRecord> = [],
): ActivationMilestoneRecord[] {
  const stage = deriveStage(input).stage;
  const detections = ACTIVATION_MILESTONE_ORDER.map((key) =>
    detectSingleMilestone(key, input, stage),
  );
  return mergeMilestoneState(prior, detections, input.now);
}

export function deriveStage(input: ActivationSignalSnapshot): {
  stage: ActivationStage;
  reasons: string[];
} {
  if (input.blockerCount > 0 || input.dependencyBlockerCount > 0) {
    return { stage: "blocked", reasons: ["Active blockers are present."] };
  }

  if (input.releasedAt || input.hasReleaseEvidence) {
    return { stage: "complete", reasons: ["Release evidence exists."] };
  }

  if (input.hasValidationEvidence || (input.hasImplementation && input.completedAt)) {
    return { stage: "validation", reasons: ["Implementation is ready for validation."] };
  }

  if (input.startedAt || input.hasImplementation) {
    return { stage: "implementation", reasons: ["Implementation has started."] };
  }

  if (input.hasRequirements || input.hasPlan) {
    return { stage: "definition", reasons: ["Requirements or plan are defined."] };
  }

  if (input.hasBrief) {
    return { stage: "discovery", reasons: ["Initial brief exists."] };
  }

  return { stage: "not_started", reasons: ["No activation signals are present."] };
}

export function mergeMilestoneState(
  prior: ReadonlyArray<ActivationMilestoneRecord>,
  nextDetections: ReadonlyArray<ActivationMilestoneRecord>,
  now: string,
): ActivationMilestoneRecord[] {
  const priorMap = new Map(prior.map((entry) => [entry.key, entry]));

  return nextDetections.map((next) => {
    const previous = priorMap.get(next.key);
    if (previous?.reached) {
      return {
        ...next,
        reached: true,
        reachedAt: previous.reachedAt ?? now,
      };
    }

    if (next.reached) {
      return {
        ...next,
        reachedAt: next.reachedAt ?? now,
      };
    }

    return next;
  });
}

function detectSingleMilestone(
  key: ActivationMilestoneKey,
  input: ActivationSignalSnapshot,
  stage: ActivationStage,
): ActivationMilestoneRecord {
  switch (key) {
    case "intake_ready":
      return reached(key, input.hasBrief, "A brief has been captured.");
    case "scope_defined":
      return reached(key, input.hasRequirements && input.hasPlan, "Requirements and plan exist.");
    case "build_started":
      return reached(
        key,
        Boolean(input.startedAt) || input.hasImplementation,
        "Implementation has started.",
      );
    case "build_complete":
      return reached(
        key,
        input.hasImplementation && Boolean(input.completedAt || input.hasTests),
        "Implementation is complete.",
      );
    case "validated":
      return reached(
        key,
        input.hasValidationEvidence && input.hasTests && input.criticalIssueCount === 0,
        "Validation evidence exists and no critical issues remain.",
      );
    case "released":
      return reached(
        key,
        Boolean(input.releasedAt) || input.hasReleaseEvidence,
        "Release evidence exists.",
      );
    case "blocked":
      return reached(key, stage === "blocked", "Blockers are preventing progress.");
  }
}

function reached(
  key: ActivationMilestoneKey,
  isReached: boolean,
  reason: string,
): ActivationMilestoneRecord {
  return {
    key,
    reached: isReached,
    reason,
  };
}
