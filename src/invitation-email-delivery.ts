import { now } from "./auth-utils";
import { createInvitationEmailDelivery, type InvitationEmailDeliveryRecord, type PacketAgentData } from "./packetagent-store";
import {
  LOCAL_INVITATION_EMAIL_PROVIDER,
  resolveInvitationEmailMode,
  resolveInvitationEmailWebhookConfig,
  PACKETAGENT_INVITATION_EMAIL_MODE_ENV,
  PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV,
} from "./invitation-email";
import { redactedErrorMessage } from "./security/redaction.js";

export type InvitationEmailDeliveryAction = "create" | "resend";

export interface InvitationEmailDeliveryRequest {
  workspaceId: string;
  workspaceName?: string;
  invitationId: string;
  email: string;
  token: string;
  subject: string;
  action: InvitationEmailDeliveryAction;
}

export interface InvitationEmailDeliveryResult {
  id: string;
  status: InvitationEmailDeliveryRecord["status"];
  action: InvitationEmailDeliveryAction;
  error: string | null;
}

export interface InvitationEmailDeliveryTestRecord extends InvitationEmailDeliveryRequest {
  id: string;
  status: InvitationEmailDeliveryRecord["status"];
  error: string | null;
  createdAt: string;
  sentAt?: string;
}

type InvitationEmailDeliveryAdapter = (request: InvitationEmailDeliveryRequest) => void | Promise<void>;
type InvitationEmailFetch = typeof fetch;

let adapter: InvitationEmailDeliveryAdapter | null = null;
let fetchForTests: InvitationEmailFetch | null = null;
let recordsForTests: InvitationEmailDeliveryTestRecord[] = [];

export async function deliverInvitationEmail(
  data: PacketAgentData,
  request: InvitationEmailDeliveryRequest,
  timestamp = now(),
): Promise<InvitationEmailDeliveryResult> {
  const mode = resolveInvitationEmailMode();
  const skipped = mode === "skip";
  let status: InvitationEmailDeliveryRecord["status"] = skipped ? "skipped" : "sent";
  let error: string | undefined = skipped ? `${PACKETAGENT_INVITATION_EMAIL_MODE_ENV}=skip` : undefined;
  let provider = LOCAL_INVITATION_EMAIL_PROVIDER;

  if (!skipped) {
    try {
      if (mode === "webhook") {
        const webhook = resolveInvitationEmailWebhookConfig();
        provider = webhook.provider;
        await sendInvitationEmailWebhook(request, webhook, fetchForTests ?? fetch);
      } else {
        await (adapter?.(request) ?? undefined);
      }
    } catch (caught) {
      status = "failed";
      error = redactedErrorMessage(caught, [request.token]);
    }
  }

  const delivery = createInvitationEmailDelivery(data, {
    workspaceId: request.workspaceId,
    invitationId: request.invitationId,
    recipientEmail: request.email,
    subject: request.subject,
    status,
    provider,
    mode,
    sentAt: status === "sent" ? timestamp : undefined,
    error,
  }, timestamp);

  recordsForTests.push({
    ...request,
    id: delivery.id,
    email: delivery.recipientEmail,
    status,
    error: error ?? null,
    createdAt: delivery.createdAt,
    sentAt: delivery.sentAt,
  });

  return { id: delivery.id, status, action: request.action, error: error ?? null };
}

export function setInvitationEmailDeliveryAdapterForTests(nextAdapter: InvitationEmailDeliveryAdapter): void {
  adapter = nextAdapter;
}

export function setInvitationEmailFetchForTests(nextFetch: InvitationEmailFetch): void {
  fetchForTests = nextFetch;
}

export function listInvitationEmailDeliveryRecordsForTests(): InvitationEmailDeliveryTestRecord[] {
  return recordsForTests.slice();
}

export function resetInvitationEmailDeliveryForTests(): void {
  adapter = null;
  fetchForTests = null;
  recordsForTests = [];
}

async function sendInvitationEmailWebhook(
  request: InvitationEmailDeliveryRequest,
  webhook: ReturnType<typeof resolveInvitationEmailWebhookConfig>,
  fetchImplementation: InvitationEmailFetch,
): Promise<void> {
  if (!webhook.url) throw new Error(`${PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV} is required when ${PACKETAGENT_INVITATION_EMAIL_MODE_ENV}=webhook`);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (webhook.secret) headers[webhook.secretHeader] = webhook.secret;

  const response = await fetchImplementation(webhook.url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(webhook.timeoutMs),
    body: JSON.stringify({
      workspaceId: request.workspaceId,
      workspaceName: request.workspaceName,
      invitationId: request.invitationId,
      email: request.email,
      token: request.token,
      subject: request.subject,
      action: request.action,
    }),
  });

  if (!response.ok) throw new Error(`webhook invitation email provider returned ${response.status} ${response.statusText}`.trim());
}
