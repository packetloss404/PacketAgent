import type { IconKey } from "../../icons";

export type AdvancedEntry = {
  label: string;
  path: string;
  icon: IconKey;
  owner: "Workspace" | "Admin";
  description: string;
};

export const ADVANCED_GROUPS: Array<{ title: string; note: string; entries: AdvancedEntry[] }> = [
  {
    title: "Run Control",
    note: "Operational views for diagnosing, testing, and tuning live workspaces.",
    entries: [
      {
        label: "Operations",
        path: "/operations",
        icon: "pulse",
        owner: "Workspace",
        description: "Health, alerts, and background job metrics.",
      },
      {
        label: "Sandbox",
        path: "/sandbox",
        icon: "cpu",
        owner: "Workspace",
        description: "Inspect and run isolated command executions.",
      },
      {
        label: "Activation",
        path: "/activation",
        icon: "rocket",
        owner: "Workspace",
        description: "Track builder adoption and usage signals.",
      },
      {
        label: "Rate limits",
        path: "/rate-limits",
        icon: "gauge",
        owner: "Admin",
        description: "Provider quotas, throttles, and usage limits.",
      },
    ],
  },
  {
    title: "Access And Trust",
    note: "Admin-only controls for people, authentication, and sensitive credentials.",
    entries: [
      {
        label: "Billing",
        path: "/billing",
        icon: "card",
        owner: "Admin",
        description: "Plan status, seats, and payment records.",
      },
      {
        label: "Roles",
        path: "/roles",
        icon: "shield",
        owner: "Admin",
        description: "Workspace permissions and grant bundles.",
      },
      {
        label: "SSO",
        path: "/sso",
        icon: "lock",
        owner: "Admin",
        description: "Single sign-on and authentication policy.",
      },
      {
        label: "Secrets",
        path: "/secrets",
        icon: "vault",
        owner: "Admin",
        description: "Credential storage, rotation, and access state.",
      },
    ],
  },
  {
    title: "Platform Plumbing",
    note: "Advanced admin tools that usually sit behind the builder workflow.",
    entries: [
      {
        label: "Webhooks",
        path: "/webhooks",
        icon: "webhook",
        owner: "Admin",
        description: "Outbound events, retry state, and signing keys.",
      },
      {
        label: "Notifications",
        path: "/notifications",
        icon: "bell",
        owner: "Admin",
        description: "Email, inbox, and alert delivery settings.",
      },
    ],
  },
];

export function advancedEntryCount(canManageWorkspace: boolean): number {
  return ADVANCED_GROUPS.reduce(
    (sum, group) =>
      sum + group.entries.filter((entry) => canManageWorkspace || entry.owner !== "Admin").length,
    0,
  );
}
