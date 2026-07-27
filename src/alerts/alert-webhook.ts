import { redactedErrorMessage } from "../security/redaction.js";
import type { AlertEvent } from "./alert-engine.js";

export const ALERT_WEBHOOK_URL_ENV = "PACKETAGENT_ALERT_WEBHOOK_URL";
export const ALERT_WEBHOOK_SECRET_ENV = "PACKETAGENT_ALERT_WEBHOOK_SECRET";
export const ALERT_WEBHOOK_SECRET_HEADER_ENV = "PACKETAGENT_ALERT_WEBHOOK_SECRET_HEADER";
export const ALERT_WEBHOOK_TIMEOUT_MS_ENV = "PACKETAGENT_ALERT_WEBHOOK_TIMEOUT_MS";

export const DEFAULT_ALERT_WEBHOOK_SECRET_HEADER = "x-packetagent-alert-secret";
export const DEFAULT_ALERT_WEBHOOK_TIMEOUT_MS = 5000;

export interface AlertWebhookConfig {
  url: string;
  secret?: string;
  secretHeader: string;
  timeoutMs: number;
}

export interface DeliverAlertWebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface DeliverAlertWebhookDeps {
  fetchImpl?: typeof fetch;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function resolveAlertWebhookConfig(env: NodeJS.ProcessEnv = process.env): AlertWebhookConfig | null {
  const url = readString(env, ALERT_WEBHOOK_URL_ENV);
  if (!url) return null;
  const secret = readString(env, ALERT_WEBHOOK_SECRET_ENV);
  const secretHeader = readString(env, ALERT_WEBHOOK_SECRET_HEADER_ENV) ?? DEFAULT_ALERT_WEBHOOK_SECRET_HEADER;
  const timeoutMs = readPositiveInt(env, ALERT_WEBHOOK_TIMEOUT_MS_ENV, DEFAULT_ALERT_WEBHOOK_TIMEOUT_MS);
  const config: AlertWebhookConfig = { url, secretHeader, timeoutMs };
  if (secret) config.secret = secret;
  return config;
}

function buildHeaders(config: AlertWebhookConfig): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (config.secret) {
    headers.set(config.secretHeader, config.secret);
  }
  return headers;
}

export async function deliverAlertWebhook(
  config: AlertWebhookConfig,
  events: AlertEvent[],
  deps: DeliverAlertWebhookDeps = {},
): Promise<DeliverAlertWebhookResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const body = JSON.stringify({
    alerts: events,
    deliveredAt: new Date().toISOString(),
  });

  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: buildHeaders(config),
      body,
      signal: controller.signal,
    });
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    return { ok: false, status: response.status, error: `http ${response.status}` };
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: "timeout" };
    }
    const knownSecrets = config.secret ? [config.secret] : [];
    return { ok: false, error: `network: ${redactedErrorMessage(error, knownSecrets)}` };
  } finally {
    clearTimeout(timeout);
  }
}
