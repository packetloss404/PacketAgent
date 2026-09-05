import { test } from "node:test";
import assert from "node:assert/strict";
import { app, GOOGLE_FONTS_FILE_ORIGIN, GOOGLE_FONTS_STYLE_ORIGIN } from "./server.js";

function directive(policy: string, name: string): string {
  const found = policy
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry === name || entry.startsWith(`${name} `));
  assert.ok(found, `expected a ${name} directive in: ${policy}`);
  return found;
}

test("the workbench CSP allows the Google Fonts stylesheet and font files", async () => {
  const response = await app.request("/api/health");
  const policy = response.headers.get("content-security-policy");
  assert.ok(policy, "expected a Content-Security-Policy header");

  const styleSrc = directive(policy, "style-src");
  assert.ok(
    styleSrc.includes(GOOGLE_FONTS_STYLE_ORIGIN),
    `style-src must allow the font stylesheet origin, got: ${styleSrc}`,
  );

  const fontSrc = directive(policy, "font-src");
  assert.ok(
    fontSrc.includes(GOOGLE_FONTS_FILE_ORIGIN),
    `font-src must allow the font file origin, got: ${fontSrc}`,
  );
});

test("the workbench CSP keeps its restrictive defaults", async () => {
  const response = await app.request("/api/health");
  const policy = response.headers.get("content-security-policy") ?? "";

  assert.equal(directive(policy, "default-src"), "default-src 'self'");
  assert.equal(directive(policy, "script-src"), "script-src 'self'");
  assert.equal(directive(policy, "object-src"), "object-src 'none'");
  assert.equal(directive(policy, "base-uri"), "base-uri 'self'");
  assert.ok(!policy.includes("'unsafe-eval'"), "the policy must not permit eval");
  assert.ok(
    !directive(policy, "script-src").includes(GOOGLE_FONTS_STYLE_ORIGIN),
    "the font origin must not be trusted for scripts",
  );
});
