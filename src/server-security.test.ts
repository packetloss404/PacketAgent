import assert from "node:assert/strict";
import test from "node:test";
import { artifactServingEnabled } from "./server.js";

test("artifact serving is disabled by default in production", () => {
  assert.equal(artifactServingEnabled({ NODE_ENV: "production" }), false);
});

test("artifact serving is disabled by default in development (explicit opt-in required)", () => {
  assert.equal(artifactServingEnabled({ NODE_ENV: "development" }), false);
});

test("artifact serving is disabled by default when NODE_ENV is unset", () => {
  assert.equal(artifactServingEnabled({}), false);
});

test("artifact serving requires explicit opt-in in production", () => {
  assert.equal(artifactServingEnabled({
    NODE_ENV: "production",
    PACKETAGENT_ARTIFACT_SERVING_ENABLED: "true",
  }), true);
});

test("artifact serving requires explicit opt-in in development", () => {
  assert.equal(artifactServingEnabled({
    NODE_ENV: "development",
    PACKETAGENT_ARTIFACT_SERVING_ENABLED: "1",
  }), true);
});

test("artifact serving stays off when explicitly disabled", () => {
  assert.equal(artifactServingEnabled({
    NODE_ENV: "development",
    PACKETAGENT_ARTIFACT_SERVING_ENABLED: "false",
  }), false);
});
