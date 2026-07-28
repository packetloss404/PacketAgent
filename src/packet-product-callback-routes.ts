import { Hono, type Context } from "hono";
import { createPacketChatCallbackService, PacketChatCallbackError } from "./workers/packetchat.js";

export interface PacketProductCallbackRoutesDependencies {
  readonly packetChat?: ReturnType<typeof createPacketChatCallbackService>;
}

export function createPacketProductCallbackRoutes(
  dependencies: PacketProductCallbackRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const packetChat = dependencies.packetChat ?? createPacketChatCallbackService();

  routes.get("/packetchat/worker-callback", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    try {
      const token = c.req.query("token");
      if (!token) {
        throw new PacketChatCallbackError("invalid_token");
      }
      return c.json(await packetChat.authenticate(token));
    } catch (error) {
      return callbackError(c, error);
    }
  });

  return routes;
}

function callbackError(c: Context, error: unknown) {
  const status = error instanceof PacketChatCallbackError ? error.status : 500;
  c.status(status);
  return c.json({
    error:
      error instanceof PacketChatCallbackError
        ? "PacketChat Worker callback authentication failed."
        : "PacketChat Worker callback failed.",
    ...(error instanceof PacketChatCallbackError ? { code: "invalid_callback" } : {}),
  });
}

export const packetProductCallbackRoutes = createPacketProductCallbackRoutes();
