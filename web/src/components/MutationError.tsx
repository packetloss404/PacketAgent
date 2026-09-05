import { AsyncStateBoundary } from "./AsyncStateBoundary";

/**
 * Inline surface for a `useMutation` failure. Renders nothing while there is no
 * error, and an assertive `role="alert"` region (the shared async-state
 * primitive) once there is one, so the message is announced without a toast.
 */
export function MutationError({
  error,
  onRetry,
  retryLabel = "Try again",
  inline = false,
}: {
  readonly error: string | null | undefined;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly inline?: boolean;
}) {
  if (!error) return null;
  return (
    <AsyncStateBoundary
      inline={inline}
      state={{ kind: "error", message: error, role: "alert", ariaLive: "assertive" }}
      onRetry={onRetry}
      retryLabel={retryLabel}
    />
  );
}
