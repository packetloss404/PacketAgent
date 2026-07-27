import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ALERT_WEBHOOK_SECRET_HEADER,
  DEFAULT_ALERT_WEBHOOK_TIMEOUT_MS,
  deliverAlertWebhook,
  resolveAlertWebhookConfig,
} from "./alert-webhook.js";
import type { AlertEvent } from "./alert-engine.js";

function makeEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: overrides.id ?? "evt-1",
    ruleId: overrides.ruleId ?? "subsystem-degraded",
    severity: overrides.severity ?? "warning",
    title: overrides.title ?? "Subsystem store degraded",
    detail: overrides.detail ?? "details",
    observedAt: overrides.observedAt ?? "2026-04-26T12:00:00.000Z",
    context: overrides.context ?? { subsystem: "store" },
  };
}

test("resolveAlertWebhookConfig returns null when URL is unset", () => {
  assert.equal(resolveAlertWebhookConfig({}), null);
  assert.equal(resolveAlertWebhookConfig({ PACKETAGENT_ALERT_WEBHOOK_URL: "" }), null);
  assert.equal(resolveAlertWebhookConfig({ PACKETAGENT_ALERT_WEBHOOK_URL: "   " }), null);
});

test("resolveAlertWebhookConfig returns config with defaults when only URL is set", () => {
  const config = resolveAlertWebhookConfig({
    PACKETAGENT_ALERT_WEBHOOK_URL: "https://example.com/alerts",
  });
  assert.deepEqual(config, {
    url: "https://example.com/alerts",
    secretHeader: DEFAULT_ALERT_WEBHOOK_SECRET_HEADER,
    timeoutMs: DEFAULT_ALERT_WEBHOOK_TIMEOUT_MS,
  });
});

test("resolveAlertWebhookConfig honors custom secret, secretHeader, and timeoutMs", () => {
  const config = resolveAlertWebhookConfig({
    PACKETAGENT_ALERT_WEBHOOK_URL: "https://example.com/alerts",
    PACKETAGENT_ALERT_WEBHOOK_SECRET: "shhh",
    PACKETAGENT_ALERT_WEBHOOK_SECRET_HEADER: "x-custom-header",
    PACKETAGENT_ALERT_WEBHOOK_TIMEOUT_MS: "1500",
  });
  assert.deepEqual(config, {
    url: "https://example.com/alerts",
    secret: "shhh",
    secretHeader: "x-custom-header",
    timeoutMs: 1500,
  });
});

test("resolveAlertWebhookConfig falls back to default timeoutMs for invalid values", () => {
  const config = resolveAlertWebhookConfig({
    PACKETAGENT_ALERT_WEBHOOK_URL: "https://example.com/alerts",
    PACKETAGENT_ALERT_WEBHOOK_TIMEOUT_MS: "not-a-number",
  });
  assert.equal(config?.timeoutMs, DEFAULT_ALERT_WEBHOOK_TIMEOUT_MS);
});

test("deliverAlertWebhook posts JSON body and returns ok on 2xx", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

  const events = [makeEvent()];
  const result = await deliverAlertWebhook(
    {
      url: "https://example.com/alerts",
      secret: "shhh",
      secretHeader: "x-packetagent-alert-secret",
      timeoutMs: 5000,
    },
    events,
    { fetchImpl },
  );

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://example.com/alerts");
  assert.equal(call.init?.method, "POST");
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-packetagent-alert-secret"), "shhh");
  const parsed = JSON.parse(String(call.init?.body)) as { alerts: AlertEvent[]; deliveredAt: string };
  assert.deepEqual(parsed.alerts, events);
  assert.equal(typeof parsed.deliveredAt, "string");
  assert.ok(!Number.isNaN(Date.parse(parsed.deliveredAt)));
});

test("deliverAlertWebhook omits secret header when no secret is configured", async () => {
  let capturedHeaders: Headers | null = null;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const result = await deliverAlertWebhook(
    {
      url: "https://example.com/alerts",
      secretHeader: "x-packetagent-alert-secret",
      timeoutMs: 5000,
    },
    [makeEvent()],
    { fetchImpl },
  );

  assert.deepEqual(result, { ok: true, status: 204 });
  assert.ok(capturedHeaders);
  assert.equal((capturedHeaders as Headers).get("x-packetagent-alert-secret"), null);
});

test("deliverAlertWebhook returns http error for non-2xx", async () => {
  const fetchImpl = (async () => new Response("oops", { status: 502 })) as unknown as typeof fetch;
  const result = await deliverAlertWebhook(
    { url: "https://example.com/alerts", secretHeader: "x-packetagent-alert-secret", timeoutMs: 5000 },
    [makeEvent()],
    { fetchImpl },
  );
  assert.deepEqual(result, { ok: false, status: 502, error: "http 502" });
});

test("deliverAlertWebhook returns network error and never throws", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const result = await deliverAlertWebhook(
    { url: "https://example.com/alerts", secretHeader: "x-packetagent-alert-secret", timeoutMs: 5000 },
    [makeEvent()],
    { fetchImpl },
  );
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error?.startsWith("network: "));
});

test("deliverAlertWebhook redacts the configured secret from error messages", async () => {
  const fetchImpl = (async () => {
    throw new Error("failed to reach https://example.com with secret super-secret-token");
  }) as unknown as typeof fetch;
  const result = await deliverAlertWebhook(
    {
      url: "https://example.com/alerts",
      secret: "super-secret-token",
      secretHeader: "x-packetagent-alert-secret",
      timeoutMs: 5000,
    },
    [makeEvent()],
    { fetchImpl },
  );
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.ok(!result.error.includes("super-secret-token"));
});

test("deliverAlertWebhook returns timeout when fetch is aborted", async () => {
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          (error as Error & { name: string }).name = "AbortError";
          reject(error);
        });
      }
    });
  }) as unknown as typeof fetch;

  const result = await deliverAlertWebhook(
    { url: "https://example.com/alerts", secretHeader: "x-packetagent-alert-secret", timeoutMs: 10 },
    [makeEvent()],
    { fetchImpl },
  );

  assert.deepEqual(result, { ok: false, error: "timeout" });
});

test("deliverAlertWebhook body shape contains alerts and deliveredAt", async () => {
  let capturedBody: string | null = null;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body);
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

  const events = [makeEvent({ id: "a" }), makeEvent({ id: "b", severity: "critical" })];
  await deliverAlertWebhook(
    { url: "https://example.com/alerts", secretHeader: "x-packetagent-alert-secret", timeoutMs: 5000 },
    events,
    { fetchImpl },
  );

  assert.ok(capturedBody);
  const parsed = JSON.parse(capturedBody as string) as { alerts: AlertEvent[]; deliveredAt: string };
  assert.equal(Array.isArray(parsed.alerts), true);
  assert.equal(parsed.alerts.length, 2);
  assert.equal(parsed.alerts[0].id, "a");
  assert.equal(parsed.alerts[1].id, "b");
  assert.equal(typeof parsed.deliveredAt, "string");
});
