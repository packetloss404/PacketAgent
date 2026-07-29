import type { AlertEventRecord, PacketAgentData } from "../packetagent-store.js";
import { loadStoreAsync as defaultLoadStoreAsync } from "../packetagent-store.js";
import {
  resolveAlertWebhookConfig,
  deliverAlertWebhook,
  type AlertWebhookConfig,
} from "./alert-webhook.js";
import {
  updateAlertDeliveryStatusAsync,
  type UpdateAlertDeliveryStatusInput,
} from "./alert-store.js";
import { redactedErrorMessage } from "../security/redaction.js";
import type { AlertEvent } from "./alert-engine.js";

export const ALERTS_DELIVER_JOB_TYPE = "alerts.deliver" as const;

export const ALERT_DELIVER_MAX_ATTEMPTS_ENV = "PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS";

const DEFAULT_MAX_ATTEMPTS = 3;

export interface AlertsDeliverJobPayload {
  alertId: string;
}

export interface AlertsDeliverJobResult {
  alertId: string;
  delivered: boolean;
  deliveryError?: string;
  deadLettered: boolean;
  attemptNumber: number;
}

export interface AlertsDeliverHandlerDeps {
  loadStore?: () => PacketAgentData | Promise<PacketAgentData>;
  webhookConfig?: () => AlertWebhookConfig | null;
  deliver?: typeof deliverAlertWebhook;
  updateStatus?: (
    input: UpdateAlertDeliveryStatusInput,
  ) => AlertEventRecord | null | Promise<AlertEventRecord | null>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

function resolveMaxAttempts(env: NodeJS.ProcessEnv): number {
  const raw = env[ALERT_DELIVER_MAX_ATTEMPTS_ENV];
  if (typeof raw !== "string") return DEFAULT_MAX_ATTEMPTS;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_MAX_ATTEMPTS;
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_ATTEMPTS;
  const parsed = parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_ATTEMPTS;
  return parsed;
}

function toAlertEvent(record: AlertEventRecord): AlertEvent {
  return {
    id: record.id,
    ruleId: record.ruleId,
    severity: record.severity,
    title: record.title,
    detail: record.detail,
    observedAt: record.observedAt,
    context: record.context,
  };
}

export async function handleAlertsDeliverJob(
  payload: AlertsDeliverJobPayload,
  deps: AlertsDeliverHandlerDeps = {},
): Promise<AlertsDeliverJobResult> {
  const loadStore = deps.loadStore ?? defaultLoadStoreAsync;
  const webhookConfigFn = deps.webhookConfig ?? (() => resolveAlertWebhookConfig());
  const deliverFn = deps.deliver ?? deliverAlertWebhook;
  const updateStatus = deps.updateStatus ?? updateAlertDeliveryStatusAsync;
  const nowFn = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;

  const alertId = payload?.alertId;
  if (typeof alertId !== "string" || alertId.trim() === "") {
    throw new Error("alerts.deliver: payload.alertId must be a non-empty string");
  }

  const data = await loadStore();
  const collection: AlertEventRecord[] = Array.isArray(data.alertEvents) ? data.alertEvents : [];
  const record = collection.find((entry) => entry.id === alertId);
  if (!record) {
    throw Object.assign(new Error("alert not found"), { status: 404 });
  }

  const maxAttempts = resolveMaxAttempts(env);
  const previousAttempts = record.deliveryAttempts ?? 0;
  const attemptNumber = previousAttempts + 1;
  const attemptedAt = nowFn().toISOString();

  if (record.delivered === true) {
    await updateStatus({ alertId, delivered: true, deadLettered: false, attemptedAt });
    return {
      alertId,
      delivered: true,
      deadLettered: false,
      attemptNumber,
    };
  }

  const config = webhookConfigFn();
  if (config === null) {
    await updateStatus({ alertId, delivered: true, deadLettered: false, attemptedAt });
    return {
      alertId,
      delivered: true,
      deadLettered: false,
      attemptNumber,
    };
  }

  const event = toAlertEvent(record);
  const result = await deliverFn(config, [event]);

  if (result.ok) {
    await updateStatus({ alertId, delivered: true, deadLettered: false, attemptedAt });
    return {
      alertId,
      delivered: true,
      deadLettered: false,
      attemptNumber,
    };
  }

  const rawError = result.error ?? "delivery failed";
  const deliveryError = redactedErrorMessage(rawError);

  if (attemptNumber >= maxAttempts) {
    await updateStatus({
      alertId,
      delivered: false,
      deliveryError,
      deadLettered: true,
      attemptedAt,
    });
    return {
      alertId,
      delivered: false,
      deliveryError,
      deadLettered: true,
      attemptNumber,
    };
  }

  throw new Error(`alert delivery attempt ${attemptNumber} failed: ${deliveryError}`);
}
