import type { IconKey } from "../icons";

export interface PreviewCheck {
  icon: IconKey;
  label: string;
  value: string;
}

export const PREVIEW_TRUTH_COPY =
  "This checkpoint is saved in PacketAgent and available through the local preview route. It is not a public deployment unless publish history includes a validated handoff URL.";

export const CHECKS: PreviewCheck[] = [
  {
    icon: "code",
    label: "Generated source",
    value: "Source metadata, route map, and app manifest are captured",
  },
  {
    icon: "branch",
    label: "Routes",
    value: "Page and API route contracts are available for review",
  },
  {
    icon: "database",
    label: "Data",
    value: "Schema and CRUD loops recorded",
  },
  {
    icon: "shield",
    label: "Auth",
    value: "Public/private/admin access preserved",
  },
  {
    icon: "check",
    label: "Smoke",
    value: "Build and smoke status are attached when checks have run",
  },
];
