import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuilderView } from "./builder";

test("App Builder cold-start composition preserves its controlled entry state", () => {
  const html = renderToStaticMarkup(createElement(BuilderView));

  assert.match(html, /What do you want to build today\?/);
  assert.match(html, /Describe what you want to build\.\.\./);
  assert.match(html, /data-tour="composer"/);
  assert.match(html, /data-tour="chips"/);
  assert.match(html, / Build<\/button>/);
  assert.match(html, />Show tour<\/button>/);
  assert.doesNotMatch(html, />Local preview</);
  assert.doesNotMatch(html, /Ready to approve/);
});
