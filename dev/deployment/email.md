# Invitation Email

PacketAgent delegates invitation email delivery. The app records every send attempt as an `invitationEmailDeliveries` row, retries failed handoffs through its built-in scheduler, and accepts inbound provider-status webhooks so deliveries that succeed out-of-band can be reconciled.

## Modes

`PACKETAGENT_INVITATION_EMAIL_MODE` selects the delivery path:

| Value                                   | Behavior                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev` (default)                         | Records local "sent" deliveries against the active store. The app does not actually transmit email. Suitable for local development and tests.                   |
| `skip` (aliases: `skipped`, `disabled`) | Records "skipped" deliveries. No outbound traffic, no retries. Use when invitations are managed entirely outside PacketAgent.                                   |
| `webhook`                               | Posts each create/resend handoff to `PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL`. Use for production with your own provider or a small webhook-worker translator. |

Failed `webhook` handoffs (configuration errors, timeouts, rejected fetches, non-2xx responses) enqueue an `invitation.email` retry job. The local `dev` and `skip` modes do not enqueue retries; they are recording adapters only.

## Webhook contract

When `PACKETAGENT_INVITATION_EMAIL_MODE=webhook`, PacketAgent posts:

```http
POST <PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL>
Content-Type: application/json
x-packetagent-webhook-secret: <PACKETAGENT_INVITATION_EMAIL_WEBHOOK_SECRET>
```

Body:

```json
{
  "workspaceId": "alpha",
  "workspaceName": "Acme",
  "invitationId": "inv_...",
  "email": "user@example.com",
  "token": "wkin_...",
  "subject": "You're invited to Acme on PacketAgent",
  "action": "create"
}
```

`action` is `create` for new invitations and `resend` for resends. `workspaceName` is optional. `token` is a bearer secret - the receiving worker should redact it from its own logs and never echo it in error strings returned to PacketAgent.

The provider or webhook worker should:

- Treat the webhook request as the durable handoff boundary from PacketAgent.
- Retry transient provider errors using provider-specific retry controls.
- Dead-letter provider-side failures with enough metadata to reconcile the PacketAgent delivery row, especially `workspaceId`, `invitationId`, recipient `email`, and `action`.
- Avoid replaying stale invitation tokens after a resend (a resend rotates the token).
- Keep provider error messages free of invitation tokens before returning them. PacketAgent redacts known patterns before storing failure messages, but providers should not rely on that.

## Retry and dead-letter

PacketAgent's built-in retry uses the persisted job scheduler:

- Retry jobs are type `invitation.email` and visible through the workspace jobs APIs and Operations UI.
- Total attempts cap at `PACKETAGENT_INVITATION_EMAIL_RETRY_MAX_ATTEMPTS` (default `3`).
- Backoff starts at 30 seconds, doubles after each failed attempt, and caps at 1 hour.
- Each failed retry writes a new `failed` delivery row and an activity entry.
- When attempts are exhausted, the job stays `failed`. That failed job is the PacketAgent dead-letter record for the delivery retry.
- The retry payload stores only `invitationId`, `action`, and the requesting user id - never the token or recipient email. The retry handler resolves the current invitation token at send time so stale resend tokens are not replayed.
- If the invitation is accepted, revoked, or expired before a retry runs, the retry is marked successful with a `skipped` delivery row instead of sending.

Use PacketAgent's failed `invitation.email` jobs to identify exhausted app-side retries. Use provider dashboards, webhook-worker queues, or provider dead-letter tooling for failures after the provider accepts a PacketAgent handoff.

## Inbound provider-status webhook

To flip a `failed` delivery to `delivered` (or update the row with a provider status), the provider or webhook worker calls PacketAgent back:

```http
POST /api/public/webhooks/invitation-email
Content-Type: application/json
x-packetagent-reconciliation-secret: <PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET>
```

The route returns `503` when the secret env is unset, so the webhook is disabled by default.

Body:

```json
{
  "deliveryId": "<packetagent invitationEmailDeliveries.id>",
  "providerStatus": "delivered | bounced | complained | deferred | dropped | failed",
  "providerDeliveryId": "<provider message id, optional>",
  "providerError": "<provider-side error string, optional>",
  "occurredAt": "<ISO timestamp, optional, defaults to now>"
}
```

Common provider aliases are normalized: `delivery` -> `delivered`, `hard_bounce` / `soft_bounce` -> `bounced`, `complaint` / `spam` -> `complained`, `defer` -> `deferred`, `drop` -> `dropped`, `fail` / `error` -> `failed`.

Responses:

- `200 { "ok": true, "deliveryId", "invitationId", "workspaceId", "providerStatus", "appliedAt" }` on success.
- `400` for malformed JSON, missing fields, or unknown provider statuses.
- `401` when the secret header is missing or wrong.
- `404 { "error": "delivery not found", "deliveryId": "<id>" }` when no row matches.
- `503` when `PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET` is unset.

Treat `4xx` as terminal - do not retry. Treat `5xx` and timeouts as retryable. Re-applying the same status is safe; the delivery row is overwritten with the latest `occurredAt`.

## Reconciliation CLI

For deliveries stuck in `failed` when no inbound webhook is wired, or when the provider confirmed delivery via dashboard but never POSTed a status update:

```bash
# Read-only listing of failed deliveries, newest first.
npm run jobs:reconcile-invitation-emails

# Filter by scope.
npm run jobs:reconcile-invitation-emails -- --workspace-id=alpha --invitation-id=inv_123

# Mark a specific delivery as resolved (equivalent to a 'delivered' provider status).
npm run jobs:reconcile-invitation-emails -- --delivery-id=del_xyz --mark-resolved

# Re-enqueue PacketAgent-side retry for a failed delivery.
npm run jobs:reconcile-invitation-emails -- --delivery-id=del_xyz --requeue
```

Output lists `deliveryId`, `invitationId`, `workspaceId`, recipient `email`, `status`, `lastError`, `providerStatus` (if set), and `attemptedAt`. Action flags are mutually exclusive. The CLI never includes invitation tokens in output and never accepts a token as input - use the invitation id or delivery id.

The CLI is a manual reconciliation tool; there is no built-in reconciliation cron. If you need recurring reconciliation, wrap it in a cron entry or scheduled remote agent that calls the inbound webhook for each stuck delivery.

## Environment variables

| Env var                                                     | Default                               | Notes                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PACKETAGENT_INVITATION_EMAIL_MODE`                         | `dev`                                 | `dev`, `skip` (aliases: `skipped`, `disabled`), or `webhook`.                                                      |
| `PACKETAGENT_INVITATION_EMAIL_PROVIDER`                     | `webhook`                             | Free-form provider tag stored on delivery rows for audit.                                                          |
| `PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL`                  | unset                                 | Required when mode is `webhook`.                                                                                   |
| `PACKETAGENT_INVITATION_EMAIL_WEBHOOK_SECRET`               | unset                                 | Optional shared secret. Sent as the configured header on every request.                                            |
| `PACKETAGENT_INVITATION_EMAIL_WEBHOOK_SECRET_HEADER`        | `x-packetagent-webhook-secret`        | Header name for the outbound shared secret.                                                                        |
| `PACKETAGENT_INVITATION_EMAIL_WEBHOOK_TIMEOUT_MS`           | `10000`                               | Per-request timeout in milliseconds.                                                                               |
| `PACKETAGENT_INVITATION_EMAIL_RETRY_MAX_ATTEMPTS`           | `3`                                   | Total queued retry attempts per delivery.                                                                          |
| `PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET`        | unset                                 | Required to enable the inbound `/api/public/webhooks/invitation-email` route. When unset, the route returns `503`. |
| `PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER` | `x-packetagent-reconciliation-secret` | Header name for the inbound shared secret.                                                                         |
