import assert from "node:assert/strict";
import test from "node:test";
import {
  createMutationController,
  describeMutationError,
  GENERIC_MUTATION_ERROR,
  type MutationConfig,
  type MutationToastInput,
} from "./mutation-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness<TInput, TResult>(
  action: MutationConfig<TInput, TResult>["action"],
  options: Partial<Omit<MutationConfig<TInput, TResult>, "action" | "pushToast">> = {},
) {
  const toasts: MutationToastInput[] = [];
  const config: MutationConfig<TInput, TResult> = {
    ...options,
    action,
    pushToast: (toast) => toasts.push(toast),
  };
  const controller = createMutationController<TInput, TResult>(config);
  controller.attach();
  const seen: Array<ReturnType<typeof controller.getSnapshot>> = [];
  controller.subscribe(() => seen.push(controller.getSnapshot()));
  return { controller, toasts, seen };
}

test("a successful run tracks pending, awaits onSuccess, and pushes the success toast", async () => {
  const gate = deferred<{ id: string }>();
  const calls: string[] = [];
  const { controller, toasts, seen } = harness(
    (input: string) => {
      calls.push(`action:${input}`);
      return gate.promise;
    },
    {
      onSuccess: async (result, input) => {
        calls.push(`success:${result.id}:${input}`);
      },
      successToast: (result) => `Saved ${result.id}`,
    },
  );

  const outcome = controller.run("run-1");
  assert.deepEqual(controller.getSnapshot(), { pending: true, error: null, activeInput: "run-1" });

  gate.resolve({ id: "r1" });
  assert.deepEqual(await outcome, { id: "r1" });
  assert.deepEqual(controller.getSnapshot(), { pending: false, error: null, activeInput: null });
  assert.deepEqual(calls, ["action:run-1", "success:r1:run-1"]);
  assert.deepEqual(toasts, [{ tone: "success", title: "Saved r1" }]);
  assert.equal(seen.length, 2);
});

test("a failed run exposes the server message inline, toasts it, and never rejects", async () => {
  const onError: string[] = [];
  const { controller, toasts } = harness(
    async () => {
      throw new Error("Run is already finished.");
    },
    { onError: (message) => void onError.push(message) },
  );

  const outcome = await controller.run(undefined);
  assert.equal(outcome, undefined);
  assert.deepEqual(controller.getSnapshot(), {
    pending: false,
    error: "Run is already finished.",
    activeInput: null,
  });
  assert.deepEqual(toasts, [
    { tone: "error", title: "Action failed", description: "Run is already finished." },
  ]);
  assert.deepEqual(onError, ["Run is already finished."]);

  controller.reset();
  assert.equal(controller.getSnapshot().error, null);
});

test("inlineError suppresses the toast unless errorToast is forced on", async () => {
  const inlineOnly = harness(
    async () => {
      throw new Error("nope");
    },
    { inlineError: true },
  );
  await inlineOnly.controller.run(undefined);
  assert.equal(inlineOnly.controller.getSnapshot().error, "nope");
  assert.deepEqual(inlineOnly.toasts, []);

  const both = harness(
    async () => {
      throw new Error("nope");
    },
    { inlineError: true, errorToast: true },
  );
  await both.controller.run(undefined);
  assert.equal(both.toasts.length, 1);
});

test("errors already surfaced by the API client are not toasted twice", async () => {
  const { controller, toasts } = harness(async () => {
    const error = new Error("Internal server error") as Error & { surfaced?: boolean };
    error.surfaced = true;
    throw error;
  });
  await controller.run(undefined);
  assert.equal(controller.getSnapshot().error, "Internal server error");
  assert.deepEqual(toasts, []);
});

test("non-Error rejections never render as [object Object]", async () => {
  assert.equal(describeMutationError({ error: "Quota exceeded" }), "Quota exceeded");
  assert.equal(describeMutationError({ message: "Denied" }), "Denied");
  assert.equal(describeMutationError("plain string"), "plain string");
  assert.equal(describeMutationError({ code: 7 }), GENERIC_MUTATION_ERROR);
  assert.equal(describeMutationError(new Error("   ")), GENERIC_MUTATION_ERROR);
  assert.equal(describeMutationError(undefined), GENERIC_MUTATION_ERROR);

  const { controller, toasts } = harness(async () => {
    throw { code: 7 };
  });
  await controller.run(undefined);
  assert.equal(controller.getSnapshot().error, GENERIC_MUTATION_ERROR);
  assert.equal(toasts[0]?.description, GENERIC_MUTATION_ERROR);
});

test("a throwing onSuccess surfaces as a failure and a throwing onError is contained", async () => {
  const { controller, toasts } = harness(async () => "ok", {
    onSuccess: async () => {
      throw new Error("Refresh failed.");
    },
    onError: () => {
      throw new Error("handler exploded");
    },
  });
  assert.equal(await controller.run(undefined), undefined);
  assert.equal(controller.getSnapshot().error, "Refresh failed.");
  assert.equal(toasts.length, 1);
});

test("a second run while pending is ignored rather than queued", async () => {
  const gate = deferred<string>();
  let invocations = 0;
  const { controller } = harness((input: string) => {
    invocations += 1;
    return gate.promise.then((value) => `${value}:${input}`);
  });

  const first = controller.run("a");
  const second = controller.run("b");
  assert.equal(await second, undefined);
  assert.equal(invocations, 1);
  assert.equal(controller.getSnapshot().activeInput, "a");

  gate.resolve("done");
  assert.equal(await first, "done:a");
  assert.equal(controller.getSnapshot().pending, false);

  assert.equal(await controller.run("c"), "done:c");
  assert.equal(invocations, 2);
});

test("results and errors arriving after dispose do not touch state or callbacks", async () => {
  const gate = deferred<string>();
  let successCalls = 0;
  const { controller, seen, toasts } = harness(() => gate.promise, {
    onSuccess: () => void (successCalls += 1),
    successToast: "Saved",
  });
  const outcome = controller.run(undefined);
  controller.dispose();
  const published = seen.length;

  gate.resolve("late");
  assert.equal(await outcome, "late");
  assert.equal(successCalls, 0);
  assert.equal(seen.length, published);
  assert.deepEqual(controller.getSnapshot(), { pending: false, error: null, activeInput: null });
  // Toasts are global UI, so a late success still announces once.
  assert.deepEqual(toasts, [{ tone: "success", title: "Saved" }]);

  const failing = harness(async () => {
    throw new Error("late failure");
  });
  const failed = failing.controller.run(undefined);
  failing.controller.dispose();
  await failed;
  assert.equal(failing.controller.getSnapshot().error, null);
});

test("dispose aborts the in-flight signal only when the action opted in, and aborted runs stay silent", async () => {
  const signals: AbortSignal[] = [];
  const abortable = harness(
    (_input: void, { signal }) =>
      new Promise<string>((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
    { abortOnDispose: true },
  );
  const outcome = abortable.controller.run(undefined);
  abortable.controller.dispose();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(await outcome, undefined);
  assert.deepEqual(abortable.toasts, []);
  assert.equal(abortable.controller.getSnapshot().error, null);

  const passive = harness((_input: void, { signal }) => {
    signals.push(signal);
    return new Promise<string>(() => undefined);
  });
  void passive.controller.run(undefined);
  passive.controller.dispose();
  assert.equal(signals[1]?.aborted, false);
});

test("attach after dispose re-arms the controller for StrictMode remounts", async () => {
  const { controller } = harness(async (input: number) => input * 2);
  controller.dispose();
  assert.equal(await controller.run(2), undefined);
  controller.attach();
  assert.equal(await controller.run(2), 4);
});
