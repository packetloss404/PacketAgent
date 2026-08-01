import type { ReactNode } from "react";

export interface AccessibleAsyncState {
  readonly kind: "loading" | "error" | "empty" | "ready";
  readonly message: string;
  readonly role: "status" | "alert" | "region";
  readonly ariaLive: "polite" | "assertive" | "off";
}

export function AsyncStateBoundary({
  state,
  onRetry,
  retryLabel = "Retry",
  inline = false,
  children,
}: {
  readonly state: AccessibleAsyncState;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly inline?: boolean;
  readonly children?: ReactNode;
}) {
  if (state.kind === "ready") return <>{children}</>;

  const content = (
    <>
      <span>{state.message}</span>
      {state.kind === "error" && onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </>
  );
  const sharedProps = {
    role: state.role,
    "aria-live": state.ariaLive,
    "aria-atomic": true,
    "data-state": state.kind,
  } as const;

  return inline ? (
    <span {...sharedProps} className="async-state async-state--inline">
      {content}
    </span>
  ) : (
    <div {...sharedProps} className={`async-state async-state--${state.kind}`}>
      {content}
    </div>
  );
}
