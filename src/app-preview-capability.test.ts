import assert from "node:assert/strict";
import test from "node:test";
import {
  mintGeneratedPreviewCapability,
  verifyGeneratedPreviewCapability,
} from "./app-preview-capability.js";

const env = {
  NODE_ENV: "production",
  PACKETAGENT_PREVIEW_TOKEN_SECRET: "test-preview-secret-with-enough-entropy",
};
const now = new Date("2026-07-29T12:00:00.000Z");

test("preview capabilities bind app, workspace, checkpoint, scope, parent, and expiry", () => {
  const minted = mintGeneratedPreviewCapability({
    appId: "gapp_alpha",
    workspaceId: "alpha",
    checkpointId: "ckpt_one",
    scope: "interact",
    parentOrigin: "https://packetagent.example",
    now,
    env,
  });
  assert.match(minted.token, /^pt1\./);
  assert.equal(minted.token.includes("gapp_alpha"), false);
  assert.deepEqual(verifyGeneratedPreviewCapability(minted.token, "gapp_alpha", { now, env }), {
    ok: true,
    claims: {
      v: 1,
      appId: "gapp_alpha",
      workspaceId: "alpha",
      checkpointId: "ckpt_one",
      scope: "interact",
      parentOrigin: "https://packetagent.example",
      iat: 1_785_326_400,
      exp: 1_785_327_300,
    },
  });
  assert.deepEqual(verifyGeneratedPreviewCapability(minted.token, "gapp_beta", { now, env }), {
    ok: false,
  });
});

test("preview capability verification rejects tampering, expiry, and fallback production keys", () => {
  const minted = mintGeneratedPreviewCapability({
    appId: "gapp_alpha",
    workspaceId: "alpha",
    checkpointId: "ckpt_one",
    scope: "read",
    ttlSeconds: 60,
    now,
    env,
  });
  const tampered = `${minted.token.slice(0, -1)}${minted.token.endsWith("A") ? "B" : "A"}`;
  assert.deepEqual(verifyGeneratedPreviewCapability(tampered, "gapp_alpha", { now, env }), {
    ok: false,
  });
  assert.deepEqual(
    verifyGeneratedPreviewCapability(minted.token, "gapp_alpha", {
      now: new Date(now.getTime() + 61_000),
      env,
    }),
    { ok: false },
  );
  assert.deepEqual(
    verifyGeneratedPreviewCapability(minted.token, "gapp_alpha", {
      now,
      env: { NODE_ENV: "production" },
    }),
    { ok: false },
  );
});

test("interactive capabilities require an exact http(s) parent origin", () => {
  assert.throws(
    () =>
      mintGeneratedPreviewCapability({
        appId: "gapp_alpha",
        workspaceId: "alpha",
        checkpointId: "ckpt_one",
        scope: "interact",
        parentOrigin: "https://packetagent.example/path",
        now,
        env,
      }),
    /absolute http\(s\) origin/,
  );
});
