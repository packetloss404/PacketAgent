export type WorkerLifecycleErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_transition"
  | "idempotency_mismatch"
  | "integrity"
  | "invalid_input";

export class WorkerLifecycleError extends Error {
  readonly code: WorkerLifecycleErrorCode;
  readonly status: 400 | 404 | 409 | 500;

  constructor(
    code: WorkerLifecycleErrorCode,
    message: string,
    options: { status?: 400 | 404 | 409 | 500; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkerLifecycleError";
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
  }
}

function defaultStatus(code: WorkerLifecycleErrorCode): 400 | 404 | 409 | 500 {
  if (code === "not_found") return 404;
  if (code === "conflict" || code === "invalid_transition" || code === "idempotency_mismatch")
    return 409;
  if (code === "integrity") return 500;
  return 400;
}
