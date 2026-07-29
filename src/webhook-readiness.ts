import type { AgentTriggerKind } from "./packetagent-store";

export type WebhookTriggerReadiness = {
  recommended: boolean;
  readyAfterSave: boolean;
  tokenRequired: boolean;
  tokenManagementRoute: string;
  publicTriggerRoute: string;
  message: string;
  planDetail: string;
};

const TOKEN_MANAGEMENT_ROUTE = "/api/app/webhooks/agents/:agentId/rotate";
const PUBLIC_TRIGGER_ROUTE = "/api/public/webhooks/agents/:token";

export function buildWebhookTriggerReadiness(
  triggerKind?: AgentTriggerKind,
): WebhookTriggerReadiness {
  const recommended = triggerKind === "webhook";
  return {
    recommended,
    readyAfterSave: recommended,
    tokenRequired: recommended,
    tokenManagementRoute: TOKEN_MANAGEMENT_ROUTE,
    publicTriggerRoute: PUBLIC_TRIGGER_ROUTE,
    message: recommended
      ? "Save the agent, then create or rotate its webhook token before publishing the external trigger URL."
      : "Webhook setup is optional for this draft.",
    planDetail: recommended
      ? `After save, generate a token with POST ${TOKEN_MANAGEMENT_ROUTE}; publish POST ${PUBLIC_TRIGGER_ROUTE} only to trusted senders.`
      : "No webhook trigger is required unless the draft changes to event-driven publishing.",
  };
}
