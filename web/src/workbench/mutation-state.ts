/**
 * Framework-free lifecycle for a single write action (a "mutation").
 *
 * `useMutation` wraps this controller in React state; keeping the behaviour
 * here means the concurrency, unmount, abort, and error-surfacing rules can be
 * tested without a DOM, matching the repo's pure-state testing pattern.
 *
 * Concurrency: a mutation is serialized by ignoring re-entrant runs. While a
 * run is pending, further `run()` calls resolve to `undefined` immediately and
 * do nothing. Callers that need per-item busy states read `activeInput`.
 */

export type MutationToastTone = "success" | "error" | "info" | "warn";

export interface MutationToastInput {
  readonly tone?: MutationToastTone;
  readonly title: string;
  readonly description?: string;
}

export interface MutationContext {
  readonly signal: AbortSignal;
}

export type MutationAction<TInput, TResult> = (
  input: TInput,
  context: MutationContext,
) => Promise<TResult>;

export interface MutationOptions<TInput, TResult> {
  /** Called after the action resolves; awaited, so a failing refresh surfaces too. */
  readonly onSuccess?: (result: TResult, input: TInput) => void | Promise<void>;
  /** Called after the action rejects (never for aborted runs). */
  readonly onError?: (message: string, error: unknown, input: TInput) => void | Promise<void>;
  /** Push a success toast with this title after the action resolves. */
  readonly successToast?: string | ((result: TResult, input: TInput) => string);
  /**
   * Push an error toast with the server message. Defaults to `true`, or to
   * `false` when `inlineError` is set so the same failure is not announced twice.
   */
  readonly errorToast?: boolean;
  /** The call site renders `error` inline (via `<MutationError />`). */
  readonly inlineError?: boolean;
  /** Abort the in-flight action when the owner disposes (unmounts). Opt-in. */
  readonly abortOnDispose?: boolean;
}

export interface MutationConfig<TInput, TResult> extends MutationOptions<TInput, TResult> {
  readonly action: MutationAction<TInput, TResult>;
  readonly pushToast: (toast: MutationToastInput) => void;
}

export interface MutationSnapshot<TInput> {
  readonly pending: boolean;
  readonly error: string | null;
  readonly activeInput: TInput | null;
}

export interface MutationController<TInput, TResult> {
  run(input: TInput): Promise<TResult | undefined>;
  reset(): void;
  /** Swap in the latest action, callbacks, and options (called after each render). */
  configure(config: MutationConfig<TInput, TResult>): void;
  /** Re-arm after `dispose()`; React StrictMode mounts, unmounts, and remounts. */
  attach(): void;
  /** Stop delivering state and callbacks; aborts in-flight work when opted in. */
  dispose(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): MutationSnapshot<TInput>;
}

const IDLE: MutationSnapshot<never> = Object.freeze({
  pending: false,
  error: null,
  activeInput: null,
});

export const GENERIC_MUTATION_ERROR = "Something went wrong. Please try again.";

/** Reduce any thrown value to a human-readable message; never `[object Object]`. */
export function describeMutationError(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || GENERIC_MUTATION_ERROR;
  if (typeof error === "string") return error.trim() || GENERIC_MUTATION_ERROR;
  if (error && typeof error === "object") {
    const record = error as { error?: unknown; message?: unknown };
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  }
  return GENERIC_MUTATION_ERROR;
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** Errors that `api.ts` already announced with a toast carry this marker. */
export function wasErrorSurfaced(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { surfaced?: unknown }).surfaced === true
  );
}

export function createMutationController<TInput, TResult>(
  initialConfig: MutationConfig<TInput, TResult>,
): MutationController<TInput, TResult> {
  let config = initialConfig;
  const getConfig = () => config;
  let snapshot: MutationSnapshot<TInput> = IDLE;
  let disposed = false;
  let inflight: AbortController | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: MutationSnapshot<TInput>) => {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const run = async (input: TInput): Promise<TResult | undefined> => {
    if (snapshot.pending || disposed) return undefined;
    const controller = new AbortController();
    inflight = controller;
    publish({ pending: true, error: null, activeInput: input });
    let result: TResult;
    try {
      result = await getConfig().action(input, { signal: controller.signal });
      if (controller.signal.aborted) return undefined;
      const latest = getConfig();
      if (!disposed && latest.onSuccess) await latest.onSuccess(result, input);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return undefined;
      const latest = getConfig();
      const message = describeMutationError(error);
      const toast = latest.errorToast ?? !latest.inlineError;
      if (toast && !wasErrorSurfaced(error)) {
        latest.pushToast({ tone: "error", title: "Action failed", description: message });
      }
      if (!disposed) {
        publish({ pending: false, error: message, activeInput: null });
        try {
          await latest.onError?.(message, error, input);
        } catch {
          // The failure is already surfaced; a throwing onError must not reject `run`.
        }
      }
      return undefined;
    } finally {
      if (inflight === controller) inflight = null;
      if (!controller.signal.aborted && snapshot.pending && snapshot.activeInput === input) {
        publish({ pending: false, error: snapshot.error, activeInput: null });
      }
    }
    const latest = getConfig();
    if (latest.successToast) {
      const title =
        typeof latest.successToast === "function"
          ? latest.successToast(result, input)
          : latest.successToast;
      latest.pushToast({ tone: "success", title });
    }
    return result;
  };

  return {
    run,
    reset() {
      if (snapshot.error !== null) publish({ ...snapshot, error: null });
    },
    configure(next) {
      config = next;
    },
    attach() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      if (getConfig().abortOnDispose && inflight) {
        inflight.abort();
        inflight = null;
      }
      snapshot = IDLE;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
  };
}
