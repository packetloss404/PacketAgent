import assert from "node:assert/strict";
import test from "node:test";
import { maskSecret, redactSensitiveString, redactSensitiveValue } from "./redaction";

test("redaction masks known secrets and bearer tokens", () => {
  const secret = "invitation-token-1234";
  const redacted = redactSensitiveString(`failed for ${secret} with Bearer provider-secret-1234`, [
    secret,
  ]);

  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes("provider-secret-1234"), false);
  assert.equal(redacted.includes(maskSecret(secret)), true);
  assert.equal(redacted.includes("Bearer [redacted]"), true);
});

test("redaction removes token-bearing URLs and assignments", () => {
  const redacted = redactSensitiveString(
    "POST /api/public/webhooks/agents/whk_route_secret failed; callback=/share/share-secret-1234 api_key=sk-live-secret token=invite-secret",
  );

  assert.equal(redacted.includes("whk_route_secret"), false);
  assert.equal(redacted.includes("share-secret-1234"), false);
  assert.equal(redacted.includes("sk-live-secret"), false);
  assert.equal(redacted.includes("invite-secret"), false);
  assert.equal(redacted.includes("[redacted]"), true);
});

test("redaction does not append match offset for routes without a trailing capture group", () => {
  const redacted = redactSensitiveString(
    "/share/raw-token-1234 then /api/public/webhooks/agents/whk_secret_value tail",
  );

  assert.equal(redacted.includes("raw-token-1234"), false);
  assert.equal(redacted.includes("whk_secret_value"), false);
  assert.equal(/\/share\/\[redacted\](?!\d)/.test(redacted), true);
  assert.equal(/\/api\/public\/webhooks\/agents\/\[redacted\](?!\d)/.test(redacted), true);
});

test("redaction stops at & boundaries when redacting assignments", () => {
  const redacted = redactSensitiveString(
    "?token=raw-token-1234&access_token=other-secret-9876&keep=visible",
  );

  assert.equal(redacted.includes("raw-token-1234"), false);
  assert.equal(redacted.includes("other-secret-9876"), false);
  assert.equal(redacted.includes("keep=visible"), true);
  assert.equal(redacted.includes("token=[redacted]"), true);
  assert.equal(redacted.includes("access_token=[redacted]"), true);
});

test("value redaction masks sensitive keys recursively", () => {
  const redacted = redactSensitiveValue({
    safe: "hello",
    token: "secret-token-1234",
    nested: { authorization: "Bearer nested-secret-1234" },
  }) as { safe: string; token: string; nested: { authorization: string } };

  assert.equal(redacted.safe, "hello");
  assert.notEqual(redacted.token, "secret-token-1234");
  assert.notEqual(redacted.nested.authorization, "Bearer nested-secret-1234");
});
