import { Hono } from "hono";
import { loadStore as defaultLoadStore } from "./packetagent-store.js";
import { redactedErrorMessage } from "./security/redaction.js";

export interface HealthRoutesOptions {
  loadStore?: () => unknown;
}

export function createHealthRoutes(options: HealthRoutesOptions = {}): Hono {
  const load = options.loadStore ?? defaultLoadStore;
  const router = new Hono();

  router.get("/live", (c) => c.json({ status: "live" }));

  router.get("/ready", (c) => {
    try {
      const data = load();
      if (!data || typeof data !== "object") {
        throw new Error("store returned an unexpected shape");
      }
      return c.json({ status: "ready" });
    } catch (error) {
      return c.json({ status: "not_ready", error: redactedErrorMessage(error) }, 503);
    }
  });

  return router;
}

export const healthRoutes = createHealthRoutes();
