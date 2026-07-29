import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  assertPreviewIsolationConfigured,
  generatedPreviewBootstrapUrl,
  generatedPreviewCookieName,
  generatedPreviewCookiePath,
  isGeneratedPreviewPrimaryPath,
  isGeneratedPreviewSurfacePath,
  isPacketAgentPreviewOriginRequest,
  resolvePacketAgentPreviewOrigin,
} from "./app-preview-isolation.js";

test("development preview origin defaults to a separate loopback cookie host", () => {
  assert.equal(
    resolvePacketAgentPreviewOrigin({ NODE_ENV: "development", PORT: "9191" }),
    "http://127.0.0.2:9191",
  );
});

test("production preview isolation requires HTTPS origins on different hostnames", () => {
  assert.throws(
    () => assertPreviewIsolationConfigured({ NODE_ENV: "production" }),
    /PACKETAGENT_PREVIEW_ORIGIN is required/,
  );
  assert.throws(
    () =>
      assertPreviewIsolationConfigured({
        NODE_ENV: "production",
        PACKETAGENT_APP_ORIGIN: "https://packetagent.example",
        PACKETAGENT_PREVIEW_ORIGIN: "https://packetagent.example:9443",
      }),
    /cookies are not isolated by port/,
  );
  assert.throws(
    () =>
      assertPreviewIsolationConfigured({
        NODE_ENV: "production",
        PACKETAGENT_APP_ORIGIN: "http://packetagent.example",
        PACKETAGENT_PREVIEW_ORIGIN: "http://preview.packetagent.example",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      assertPreviewIsolationConfigured({
        NODE_ENV: "development",
        PACKETAGENT_PREVIEW_ORIGIN: "http://preview.example.test",
      }),
    /HTTP only on a loopback hostname/,
  );
  assert.deepEqual(
    assertPreviewIsolationConfigured({
      NODE_ENV: "production",
      PACKETAGENT_APP_ORIGIN: "https://packetagent.example",
      PACKETAGENT_PREVIEW_ORIGIN: "https://preview.packetagent.example",
    }),
    {
      appOrigin: "https://packetagent.example",
      previewOrigin: "https://preview.packetagent.example",
    },
  );
});

test("preview URLs keep capabilities in the fragment and cookies app-scoped", () => {
  const url = generatedPreviewBootstrapUrl(
    "https://preview.packetagent.example",
    "gapp_alpha",
    "pt1.secret",
  );
  assert.equal(
    url,
    "https://preview.packetagent.example/api/app/generated-apps/gapp_alpha/preview/#token=pt1.secret",
  );
  assert.equal(generatedPreviewCookiePath("gapp_alpha"), "/api/app/generated-apps/gapp_alpha/");
  assert.match(generatedPreviewCookieName("gapp_alpha"), /^packetagent_preview_[a-f0-9]{20}$/);
  assert.notEqual(
    generatedPreviewCookieName("gapp_alpha"),
    generatedPreviewCookieName("gapp_beta"),
  );
});

test("preview host and route classifiers fail closed around the generated surface", async () => {
  const app = new Hono();
  app.get("*", (c) =>
    c.json({
      preview: isPacketAgentPreviewOriginRequest(c, {
        NODE_ENV: "development",
        PACKETAGENT_PREVIEW_ORIGIN: "https://preview.packetagent.example",
      }),
    }),
  );
  const preview = await app.request("https://preview.packetagent.example/example");
  const primary = await app.request("https://packetagent.example/example");
  assert.deepEqual(await preview.json(), { preview: true });
  assert.deepEqual(await primary.json(), { preview: false });

  assert.equal(
    isGeneratedPreviewSurfacePath("/api/app/generated-apps/gapp_alpha/preview/src/main.tsx"),
    true,
  );
  assert.equal(
    isGeneratedPreviewSurfacePath("/api/app/generated-apps/gapp_alpha/preview-session"),
    true,
  );
  assert.equal(
    isGeneratedPreviewSurfacePath("/api/app/generated-apps/gapp_alpha/api/records"),
    true,
  );
  assert.equal(
    isGeneratedPreviewPrimaryPath("/api/app/generated-apps/gapp_alpha/preview-token"),
    true,
  );
  assert.equal(isGeneratedPreviewSurfacePath("/api/app/profile"), false);
});
