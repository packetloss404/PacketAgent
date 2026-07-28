export type WorkerOperationsAccessibleState =
  | {
      readonly kind: "loading" | "empty";
      readonly message: string;
      readonly role: "status";
      readonly ariaLive: "polite";
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly role: "alert";
      readonly ariaLive: "assertive";
    }
  | {
      readonly kind: "ready";
      readonly message: "";
      readonly role: "region";
      readonly ariaLive: "off";
    };

export function workerRunListAccessibleState(input: {
  readonly loading: boolean;
  readonly error: string | null;
  readonly visibleRuns: number;
}): WorkerOperationsAccessibleState {
  if (input.error) {
    return {
      kind: "error",
      message: input.error,
      role: "alert",
      ariaLive: "assertive",
    };
  }
  if (input.loading && input.visibleRuns === 0) {
    return {
      kind: "loading",
      message: "Loading Worker operations…",
      role: "status",
      ariaLive: "polite",
    };
  }
  if (input.visibleRuns === 0) {
    return {
      kind: "empty",
      message: "No canonical Worker runs match this view.",
      role: "status",
      ariaLive: "polite",
    };
  }
  return {
    kind: "ready",
    message: "",
    role: "region",
    ariaLive: "off",
  };
}

export function workerRunDetailAccessibleState(input: {
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasDetail: boolean;
}): WorkerOperationsAccessibleState {
  if (input.error) {
    return {
      kind: "error",
      message: input.error,
      role: "alert",
      ariaLive: "assertive",
    };
  }
  if (input.loading && !input.hasDetail) {
    return {
      kind: "loading",
      message: "Loading Worker read model…",
      role: "status",
      ariaLive: "polite",
    };
  }
  if (!input.hasDetail) {
    return {
      kind: "error",
      message: "Worker run not found.",
      role: "alert",
      ariaLive: "assertive",
    };
  }
  return {
    kind: "ready",
    message: "",
    role: "region",
    ariaLive: "off",
  };
}
