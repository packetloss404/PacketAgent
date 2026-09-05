import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { app } from "./server.js";

function directive(policy: string, name: string): string {
  const found = policy
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry === name || entry.startsWith(`${name} `));
  assert.ok(found, `expected a ${name} directive in: ${policy}`);
  return found;
}

async function contentSecurityPolicy(): Promise<string> {
  const response = await app.request("/api/health");
  const policy = response.headers.get("content-security-policy");
  assert.ok(policy, "expected a Content-Security-Policy header");
  return policy;
}

test("the workbench CSP keeps its restrictive defaults", async () => {
  const policy = await contentSecurityPolicy();

  assert.equal(directive(policy, "default-src"), "default-src 'self'");
  assert.equal(directive(policy, "script-src"), "script-src 'self'");
  assert.equal(directive(policy, "object-src"), "object-src 'none'");
  assert.equal(directive(policy, "base-uri"), "base-uri 'self'");
  assert.ok(!policy.includes("'unsafe-eval'"), "the policy must not permit eval");
});

test("styles and fonts are same-origin only, so no third-party origin is trusted", async () => {
  const policy = await contentSecurityPolicy();

  assert.equal(directive(policy, "style-src"), "style-src 'self' 'unsafe-inline'");
  assert.equal(directive(policy, "font-src"), "font-src 'self' data:");
  assert.ok(
    !/https?:\/\//.test(directive(policy, "style-src")),
    "style-src must not name an external origin",
  );
  assert.ok(
    !/https?:\/\//.test(directive(policy, "font-src")),
    "font-src must not name an external origin",
  );
});

test("the workbench requests no third-party fonts, so the CSP need not allow any", () => {
  // Guards the pairing: if a remote @import or <link> comes back, the
  // same-origin CSP above would silently block it and fonts would regress to
  // the system stack.
  for (const path of [
    "web/index.html",
    "web/src/index.css",
    "web/src/workbench/workbench.css",
    "web/src/fonts.css",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.ok(
      !source.includes("fonts.googleapis.com") && !source.includes("fonts.gstatic.com"),
      `${path} must not reference a third-party font origin`,
    );
  }

  const fontFaces = readFileSync("web/src/fonts.css", "utf8");
  assert.ok(fontFaces.includes("@font-face"), "fonts.css must declare the self-hosted faces");
  for (const family of ["Geist", "Geist Mono", "Instrument Serif"]) {
    assert.ok(fontFaces.includes(`font-family: "${family}"`), `${family} must be self-hosted`);
  }
  assert.ok(
    [...fontFaces.matchAll(/src:\s*url\("([^"]+)"\)/g)].every(([, url]) =>
      url.startsWith("/fonts/"),
    ),
    "every @font-face src must resolve to the app's own /fonts path",
  );
});
