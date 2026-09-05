import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";

import { pushExternalToast, ToastContext } from "@/context/toast-state";
import {
  createMutationController,
  type MutationAction,
  type MutationConfig,
  type MutationOptions,
  type MutationSnapshot,
} from "./mutation-state";

export type { MutationAction, MutationOptions } from "./mutation-state";

export interface UseMutationOptions<TInput, TResult> extends MutationOptions<TInput, TResult> {
  /** Abort the in-flight action (via the `signal` passed to it) when the component unmounts. */
  readonly abortOnUnmount?: boolean;
}

export interface MutationHandle<TInput, TResult> extends MutationSnapshot<TInput> {
  /**
   * Start the action. Resolves with the result, or `undefined` when the action
   * failed, was aborted, or was ignored because a run is already pending.
   * Never rejects.
   */
  readonly run: (input: TInput) => Promise<TResult | undefined>;
  /** Clear `error` without touching pending work. */
  readonly reset: () => void;
}

/**
 * Standard write-action lifecycle for the workbench.
 *
 * - `pending` is true while the action (and `onSuccess`) runs, so buttons can disable.
 * - `error` holds the server message for inline display via `<MutationError />`.
 * - An error toast is pushed by default (suppressed with `inlineError` unless
 *   `errorToast: true`, and never duplicated for errors `api.ts` already announced).
 * - Concurrent clicks are ignored while pending; `activeInput` identifies the busy item.
 * - Results arriving after unmount never touch state; `abortOnUnmount` also
 *   aborts the request, and aborted runs are silent.
 */
export function useMutation<TInput = void, TResult = unknown>(
  action: MutationAction<TInput, TResult>,
  options: UseMutationOptions<TInput, TResult> = {},
): MutationHandle<TInput, TResult> {
  const toast = useContext(ToastContext);
  const pushToast = toast?.push ?? pushExternalToast;
  const config: MutationConfig<TInput, TResult> = {
    ...options,
    abortOnDispose: options.abortOnUnmount,
    action,
    pushToast,
  };

  const [controller] = useState(() => createMutationController<TInput, TResult>(config));

  // Callers pass inline closures; keep the controller on the latest render's
  // action and callbacks without re-creating it. Effects run before any click
  // handler can call `run`, so this is never stale when it matters.
  useEffect(() => {
    controller.configure(config);
  });

  useEffect(() => {
    controller.attach();
    return () => controller.dispose();
  }, [controller]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const run = useCallback((input: TInput) => controller.run(input), [controller]);
  const reset = useCallback(() => controller.reset(), [controller]);

  return { ...snapshot, run, reset };
}
