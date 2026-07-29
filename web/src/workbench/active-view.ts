import { useLocation } from "react-router-dom";

export type ViewKey =
  | "dashboard"
  | "builder"
  | "agents"
  | "workflows"
  | "runs"
  | "integrations"
  | "operations"
  | "sandbox"
  | "activation"
  | "settings"
  | "billing"
  | "roles"
  | "sso"
  | "secrets"
  | "webhooks"
  | "rate-limits"
  | "notifications"
  | "admin";

function viewFromPath(pathname: string): ViewKey {
  const match = pathname.match(/^\/?([^/?#]*)/);
  const key = match?.[1] ?? "";
  return key ? (key as ViewKey) : "builder";
}

export function useActiveView(): ViewKey {
  return viewFromPath(useLocation().pathname);
}
