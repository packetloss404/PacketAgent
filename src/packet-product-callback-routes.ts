import { Hono, type Context } from "hono";
import { createPacketChatCallbackService, PacketChatCallbackError } from "./workers/packetchat.js";
import {
  createPacketPhoneCallbackService,
  PacketPhoneCallbackError,
} from "./workers/packetphone.js";

export interface PacketProductCallbackRoutesDependencies {
  readonly packetChat?: ReturnType<typeof createPacketChatCallbackService>;
  readonly packetPhone?: ReturnType<typeof createPacketPhoneCallbackService>;
}

export function createPacketProductCallbackRoutes(
  dependencies: PacketProductCallbackRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const packetChat = dependencies.packetChat ?? createPacketChatCallbackService();
  const packetPhone = dependencies.packetPhone ?? createPacketPhoneCallbackService();

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
      return packetChatCallbackError(c, error);
    }
  });

  routes.post("/packetphone/worker-control", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    try {
      const body = await readPacketPhoneCallbackBody(c);
      return c.json(await packetPhone.consume(body.token));
    } catch (error) {
      return packetPhoneCallbackError(c, error);
    }
  });

  return routes;
}

function packetChatCallbackError(c: Context, error: unknown) {
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

async function readPacketPhoneCallbackBody(c: Context): Promise<{ readonly token: string }> {
  if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "token") ||
    typeof (body as { token?: unknown }).token !== "string"
  ) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  return { token: (body as { token: string }).token };
}

function packetPhoneCallbackError(c: Context, error: unknown) {
  const status = error instanceof PacketPhoneCallbackError ? error.status : 500;
  c.status(status);
  return c.json({
    error:
      error instanceof PacketPhoneCallbackError
        ? "PacketPhone Worker control callback was rejected."
        : "PacketPhone Worker control callback failed.",
    ...(error instanceof PacketPhoneCallbackError
      ? {
          code:
            error.status === 403
              ? "forbidden_callback"
              : error.status === 409
                ? "rejected_callback"
                : "invalid_callback",
        }
      : {}),
  });
}

export const packetProductCallbackRoutes = createPacketProductCallbackRoutes();
