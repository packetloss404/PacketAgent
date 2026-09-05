import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MutationError } from "@/components/MutationError";
import { useMutation } from "./useMutation";

function Probe() {
  const save = useMutation(async (input: string) => input.toUpperCase(), {
    successToast: "Saved",
  });
  return (
    <button
      type="button"
      disabled={save.pending}
      aria-busy={save.pending}
      onClick={() => void save.run("x")}
    >
      {save.pending ? "Saving…" : "Save"}
      {save.activeInput ?? ""}
    </button>
  );
}

test("useMutation renders idle without a ToastProvider and exposes pending to buttons", () => {
  const markup = renderToStaticMarkup(<Probe />);
  assert.match(markup, /<button type="button" aria-busy="false">Save<\/button>/);
});

test("MutationError renders nothing when idle and an assertive alert once a message exists", () => {
  assert.equal(renderToStaticMarkup(<MutationError error={null} />), "");
  assert.equal(renderToStaticMarkup(<MutationError error="" />), "");

  const block = renderToStaticMarkup(
    <MutationError error="Run is already finished." onRetry={() => undefined} />,
  );
  assert.match(block, /role="alert" aria-live="assertive" aria-atomic="true" data-state="error"/);
  assert.match(block, /class="async-state async-state--error"/);
  assert.match(block, /Run is already finished\./);
  assert.match(block, /<button type="button" class="btn btn-sm">Try again<\/button>/);

  const inline = renderToStaticMarkup(<MutationError inline error="Denied" />);
  assert.match(inline, /<span role="alert"[^>]+class="async-state async-state--inline"/);
  assert.doesNotMatch(inline, /<button/);
});
