import { Hono, type Context } from "hono";
import { requirePrivateWorkspaceRole } from "./rbac.js";
import {
  listApiKeysForWorkspaceAsync,
  removeApiKeyForWorkspaceAsync,
  upsertApiKeyAsync,
} from "./security/api-key-store.js";
import { redactedErrorMessage } from "./security/redaction.js";
import type { ApiKeyProvider } from "./packetagent-store.js";

const VALID_PROVIDERS: ApiKeyProvider[] = [
  "anthropic",
  "openai",
  "openrouter",
  "minimax",
  "ollama",
  "gemini",
];

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function errorResponse(c: Context, error: unknown) {
  c.status(((error as Error & { status?: number }).status ?? 500) as 500);
  return c.json({ error: redactedErrorMessage(error) });
}

export const apiKeyRoutes = new Hono();

apiKeyRoutes.get("/", async (c) => {
  try {
    const { workspace } = requirePrivateWorkspaceRole(c, "viewer");
    return c.json({ apiKeys: await listApiKeysForWorkspaceAsync(workspace.id) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

apiKeyRoutes.post("/", async (c) => {
  try {
    const { workspace } = requirePrivateWorkspaceRole(c, "admin");
    const body = (await c.req.json().catch(() => ({}))) as Partial<{
      provider: string;
      label: string;
      value: string;
    }>;
    if (!body.provider || !VALID_PROVIDERS.includes(body.provider as ApiKeyProvider)) {
      throw httpError(
        400,
        "provider must be one of anthropic, openai, openrouter, minimax, ollama, gemini",
      );
    }
    if (!body.label || typeof body.label !== "string") throw httpError(400, "label is required");
    if (!body.value || typeof body.value !== "string") throw httpError(400, "value is required");
    const record = await upsertApiKeyAsync({
      workspaceId: workspace.id,
      provider: body.provider as ApiKeyProvider,
      label: body.label.trim(),
      value: body.value,
    });
    return c.json({ apiKey: record }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

apiKeyRoutes.delete("/:id", async (c) => {
  try {
    const { workspace } = requirePrivateWorkspaceRole(c, "admin");
    const removed = await removeApiKeyForWorkspaceAsync(c.req.param("id"), workspace.id);
    if (!removed) return errorResponse(c, httpError(404, "api key not found"));
    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});
